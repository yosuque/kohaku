import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApprovalGrant, ApprovalPort, ApprovalStore, ApprovalVerifyResult } from "@kohaku-ui/spec-core";
import { DEFAULT_APPROVAL_TTL_SECONDS } from "@kohaku-ui/spec-core";
import { isExpired, nowSeconds } from "./time.js";

/** Default approval TTL (seconds); the shared spec-core default. Re-exported here for convenience. */
export { DEFAULT_APPROVAL_TTL_SECONDS };

export interface HmacApprovalOptions {
  /** Default approval lifetime (seconds) when issueApproval's own opts.ttlSeconds is omitted. Defaults to 300. */
  ttlSeconds?: number;
  /**
   * Optional persistence for single-use enforcement (design.md #63). Omitted = a token stays usable
   * repeatedly until it expires (fine for a demo/dev environment; a production deployment gating a real
   * destructive action should configure one).
   */
  store?: ApprovalStore;
}

/**
 * Token-kind prefix (design.md #63). Human-readable marker only: what actually keeps this token kind from
 * being accepted by `createHmacAuthzPort` (and the converse) is cryptographic. The approval MAC key is
 * derived from the shared secret under `APPROVAL_KEY_LABEL` (so a capability port, which signs with the raw
 * secret, computes a different digest for the same bytes), and the MAC input covers the prefix as well as
 * the payload (so a signature cannot be lifted onto a token of another kind or version). The version is part
 * of the prefix: a `v1` token (whose MAC covered the payload only, under the raw secret) fails the prefix
 * check and is never accepted.
 */
const APPROVAL_TOKEN_PREFIX = "kohaku-approval.v2.";

/** Label the approval MAC key is derived under: `HMAC(secret, APPROVAL_KEY_LABEL)`. */
const APPROVAL_KEY_LABEL = "kohaku-approval-v2";

interface HmacApprovalClaims {
  action: string;
  payloadHash: string;
  approverId: string;
  requesterId: string;
  tenant?: string;
  exp: number;
  jti: string;
}

function isApprovalClaims(value: unknown): value is HmacApprovalClaims {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.action === "string" &&
    typeof c.payloadHash === "string" &&
    typeof c.approverId === "string" &&
    typeof c.requesterId === "string" &&
    (c.tenant === undefined || c.tenant === null || typeof c.tenant === "string") &&
    typeof c.exp === "number" &&
    Number.isFinite(c.exp) &&
    typeof c.jti === "string"
  );
}

/**
 * A homegrown HMAC-SHA256 approval token (design.md #63), structurally parallel to
 * `createHmacAuthzPort`'s capability token but in its own signing domain (a derived MAC key plus `APPROVAL_TOKEN_PREFIX` in the MAC input).
 * Stateless: the token itself carries every claim `verifyApproval` checks (action, payloadHash,
 * approverId, requesterId, tenant, exp), so no server-side lookup is needed to verify a fresh token --
 * single-use enforcement (replay prevention) is the only optional stateful behavior, and it is delegated
 * entirely to the caller-supplied `ApprovalStore`.
 */
export function createHmacApprovalPort(secret: string, options: HmacApprovalOptions = {}): ApprovalPort {
  const defaultTtl = options.ttlSeconds ?? DEFAULT_APPROVAL_TTL_SECONDS;
  const store = options.store;
  const approvalKey = createHmac("sha256", secret).update(APPROVAL_KEY_LABEL).digest();
  const sign = (payload: string): string =>
    createHmac("sha256", approvalKey).update(APPROVAL_TOKEN_PREFIX).update(payload).digest("base64url");

  function verifySignatureAndDecode(
    token: string,
  ): { ok: true; claims: HmacApprovalClaims } | { ok: false; reason: string } {
    if (!token.startsWith(APPROVAL_TOKEN_PREFIX)) {
      return { ok: false, reason: "not an approval token" };
    }
    const rest = token.slice(APPROVAL_TOKEN_PREFIX.length);
    const dot = rest.lastIndexOf(".");
    if (dot < 0) return { ok: false, reason: "malformed token" };
    const payload = rest.slice(0, dot);
    const signature = rest.slice(dot + 1);

    const expected = sign(payload);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, reason: "invalid signature" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return { ok: false, reason: "malformed payload" };
    }
    // A correctly signed payload is still untrusted input to this function's caller (the secret may be
    // shared with another token kind), so every claim is type-checked before use; a malformed one is a
    // denial, never an exception.
    if (!isApprovalClaims(parsed)) return { ok: false, reason: "malformed payload" };
    return { ok: true, claims: parsed };
  }

  return {
    async issueApproval(input, opts = {}) {
      if (input.approverId === input.requesterId) {
        // design.md #63: an ApprovalPort MUST reject issuing a self-approval rather than leave the check
        // to the caller (which could otherwise forget it and let a requester rubber-stamp their own action).
        throw new Error("cannot issue an approval: approverId must differ from requesterId");
      }
      const claims: HmacApprovalClaims = {
        action: input.action,
        payloadHash: input.payloadHash,
        approverId: input.approverId,
        requesterId: input.requesterId,
        tenant: input.tenant,
        exp: nowSeconds() + (opts.ttlSeconds ?? defaultTtl),
        jti: randomBytes(16).toString("base64url"),
      };
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      return `${APPROVAL_TOKEN_PREFIX}${payload}.${sign(payload)}`;
    },

    async verifyApproval(token, req): Promise<ApprovalVerifyResult> {
      const decoded = verifySignatureAndDecode(token);
      if (!decoded.ok) return { ok: false, reason: decoded.reason };
      const { claims } = decoded;

      if (isExpired(claims)) return { ok: false, reason: "approval expired" };
      if (claims.action !== req.action) {
        return { ok: false, reason: "approval is bound to a different action" };
      }
      if (claims.payloadHash !== req.payloadHash) {
        return { ok: false, reason: "approval is bound to a different payload" };
      }
      if (claims.requesterId !== req.requesterId) {
        return { ok: false, reason: "approval is bound to a different requester" };
      }
      if ((claims.tenant ?? undefined) !== (req.tenant ?? undefined)) {
        return { ok: false, reason: "approval is bound to a different tenant" };
      }
      if (claims.approverId === claims.requesterId) {
        // Defense in depth: issueApproval already refuses to mint such a token, but a hand-crafted or
        // pre-this-check token should not verify just because it happens to carry matching ids.
        return { ok: false, reason: "self-approval is not allowed" };
      }
      // Single-use enforcement is consulted last (only once every other check has passed), so a request
      // that would be denied anyway never spends a use. A store failure is not caught here -- it
      // propagates as a thrown error, per ApprovalPort.verifyApproval's doc comment (spec-core's
      // ports.ts): verifyApproval throws only on infrastructure failure, and a thrown verifyApproval is
      // fail-closed, mapped by the host to a 5xx (never treated as an allow).
      if (store != null) {
        const firstUse = await store.consume(claims.jti, claims.exp);
        if (!firstUse) return { ok: false, reason: "approval already used" };
      }
      const grant: ApprovalGrant = {
        action: claims.action,
        payloadHash: claims.payloadHash,
        approverId: claims.approverId,
        requesterId: claims.requesterId,
        tenant: claims.tenant,
        exp: claims.exp,
        jti: claims.jti,
      };
      return { ok: true, grant };
    },
  };
}

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
 * Domain-separation prefix (design.md #63): a capability token minted by `createHmacAuthzPort` never
 * carries this prefix, and an approval token is never accepted where a capability is expected, even
 * though both are HMAC-SHA256 tokens signed with (potentially) the same secret. `verifySignatureAndDecode`
 * below checks it before anything else, so a capability token presented here is rejected immediately
 * without even reaching the signature comparison -- and the converse (an approval token presented to
 * `createHmacAuthzPort`'s `verify`) is independently rejected there too, because the HMAC each port
 * computes covers a different message (this port signs only the payload *after* the prefix; a capability
 * port signing the whole string, prefix included, produces a different digest).
 */
const APPROVAL_TOKEN_PREFIX = "kohaku-approval.v1.";

interface HmacApprovalClaims {
  action: string;
  payloadHash: string;
  approverId: string;
  requesterId: string;
  tenant?: string;
  exp: number;
  jti: string;
}

/**
 * A homegrown HMAC-SHA256 approval token (design.md #63), structurally parallel to
 * `createHmacAuthzPort`'s capability token but in its own signing domain (`APPROVAL_TOKEN_PREFIX`).
 * Stateless: the token itself carries every claim `verifyApproval` checks (action, payloadHash,
 * approverId, requesterId, tenant, exp), so no server-side lookup is needed to verify a fresh token --
 * single-use enforcement (replay prevention) is the only optional stateful behavior, and it is delegated
 * entirely to the caller-supplied `ApprovalStore`.
 */
export function createHmacApprovalPort(secret: string, options: HmacApprovalOptions = {}): ApprovalPort {
  const defaultTtl = options.ttlSeconds ?? DEFAULT_APPROVAL_TTL_SECONDS;
  const store = options.store;
  const sign = (payload: string): string => createHmac("sha256", secret).update(payload).digest("base64url");

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

    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as HmacApprovalClaims;
      return { ok: true, claims };
    } catch {
      return { ok: false, reason: "malformed payload" };
    }
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

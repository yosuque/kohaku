import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthzPort, CapabilityRevocationStore, Principal, Scope } from "@kohaku-ui/spec-core";
import { DEFAULT_CAPABILITY_TTL_SECONDS } from "@kohaku-ui/spec-core";
import { createMemoryRevocationStore } from "./revocation.js";

export interface HmacAuthzOptions {
  /** Default capability lifetime (seconds) when issueCapability's own opts.ttlSeconds is omitted. Defaults to 600. */
  ttlSeconds?: number;
  /**
   * The store consulted by `verify` / `revokeCapability` for pre-expiry revocation. Defaults to a
   * private in-memory store (fine for a single instance; a multi-instance deployment should inject a
   * shared store, e.g. from `@kohaku-ui/storage-redis` or `@kohaku-ui/storage-postgres`).
   */
  revocations?: CapabilityRevocationStore;
}

/** Default capability TTL (seconds); the shared spec-core default. Re-exported here for backward compatibility. */
export { DEFAULT_CAPABILITY_TTL_SECONDS };

export type RevokeCapabilityResult = { ok: true } | { ok: false; reason: string };

export interface HmacAuthzPort extends AuthzPort {
  /**
   * Revokes a capability before its `exp`. The token's signature is verified first, so a caller cannot
   * revoke a `jti` it merely guessed -- a tampered or foreign token is rejected. An already-expired
   * token is a no-op (writing a revocation record for something that can no longer verify would just
   * grow the store for nothing). A token minted before this feature existed carries no `jti` and
   * therefore cannot be revoked either -- it simply verifies until it expires on its own, deliberately,
   * so a rolling deploy does not invalidate an old instance's already-issued tokens.
   */
  revokeCapability(token: string): Promise<RevokeCapabilityResult>;
}

interface HmacClaims {
  sub: string;
  scopes: Scope[];
  exp: number;
  /** Absent on a token minted before revocation support existed. */
  jti?: string;
}

/**
 * A homegrown HMAC-SHA256 capability token (on-behalf-of: the host acts under the user's delegated authority).
 * A structure whose contents are transparent, prioritizing didactic value: base64url(payload).base64url(hmac)
 * payload = { sub, scopes: [{kind, ref}], exp, jti }
 */
export function createHmacAuthzPort(secret: string, options: HmacAuthzOptions = {}): HmacAuthzPort {
  const defaultTtl = options.ttlSeconds ?? DEFAULT_CAPABILITY_TTL_SECONDS;
  const revocations = options.revocations ?? createMemoryRevocationStore();
  const sign = (payload: string): string => createHmac("sha256", secret).update(payload).digest("base64url");

  /** Verifies the signature and decodes the payload. Shared by `verify` and `revokeCapability`. */
  function verifySignatureAndDecode(
    token: string,
  ): { ok: true; claims: HmacClaims } | { ok: false; reason: string } {
    const dot = token.lastIndexOf(".");
    if (dot < 0) return { ok: false, reason: "malformed token" };
    const payload = token.slice(0, dot);
    const signature = token.slice(dot + 1);

    const expected = sign(payload);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, reason: "invalid signature" };
    }

    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as HmacClaims;
      return { ok: true, claims };
    } catch {
      return { ok: false, reason: "malformed payload" };
    }
  }

  return {
    async issueCapability(principal: Principal, scopes: Scope[], opts = {}) {
      const payload = Buffer.from(
        JSON.stringify({
          sub: principal.id,
          scopes,
          exp: Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? defaultTtl),
          jti: randomBytes(16).toString("base64url"),
        }),
      ).toString("base64url");
      return `${payload}.${sign(payload)}`;
    },

    async verify(token, req) {
      const decoded = verifySignatureAndDecode(token);
      if (!decoded.ok) return decoded;
      const { claims } = decoded;

      if (claims.exp < Math.floor(Date.now() / 1000)) {
        return { ok: false, reason: "capability expired" };
      }
      if (claims.jti != null && (await revocations.isRevoked(claims.jti))) {
        return { ok: false, reason: "capability revoked" };
      }
      const granted = claims.scopes.some((scope) => scope.kind === req.kind && req.ref === scope.ref);
      if (!granted) {
        return { ok: false, reason: `scope does not cover ${req.kind}:${req.ref}` };
      }
      return { ok: true, principal: { id: claims.sub } };
    },

    async revokeCapability(token) {
      const decoded = verifySignatureAndDecode(token);
      if (!decoded.ok) return decoded;
      const { claims } = decoded;

      if (claims.exp < Math.floor(Date.now() / 1000)) {
        return { ok: false, reason: "capability expired" };
      }
      if (claims.jti == null) {
        return { ok: false, reason: "token predates revocation support" };
      }
      await revocations.revoke(claims.jti, claims.exp);
      return { ok: true };
    },
  };
}

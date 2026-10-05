import type { Principal } from "./domain.js";

/** Issuance and verification of on-behalf-of capability tokens. */
export interface Scope {
  kind: "read" | "write";
  /**
   * The allowed query:// URI (read) / action name (write). Matched by **exact equality**. Prefix
   * matching is not used because it creates value/name boundary escapes (`?region=us` permitting
   * `?region=usa`, action "x" permitting "xEvil"). Since the issuer fully enumerates the reachable
   * refs of a bind as variants (SPEC §5 A1), exact matching loses no expressiveness. Reserved
   * parameters (`_*`) are stripped back to the base ref before matching.
   */
  ref: string;
}

export interface VerifyRequest {
  kind: "read" | "write";
  ref: string;
}

export interface VerifyResult {
  ok: boolean;
  principal?: Principal;
  reason?: string;
}

/**
 * Default lifetime (seconds) of a capability token when the issuer is given no explicit TTL.
 * Shared by every AuthzPort implementation and by host-core's issuance helpers.
 */
export const DEFAULT_CAPABILITY_TTL_SECONDS = 600;

/**
 * Issuance and verification of on-behalf-of capability tokens (see `Scope`'s doc comment for the exact-match
 * contract). A concrete port may extend this with a `revokeCapability` method (see `CapabilityRevocationStore`
 * below); that extension is not part of the `AuthzPort` contract itself.
 */
export interface AuthzPort {
  issueCapability(principal: Principal, scopes: Scope[], opts?: { ttlSeconds?: number }): Promise<string>;
  /**
   * Verifies a capability token against a requested scope. A denial is a normal, expected outcome and MUST
   * be reported as `{ ok: false, reason }`, never thrown. `verify` MUST throw only on an infrastructure
   * failure it cannot itself classify as allow/deny (e.g. a revocation-store outage) -- and such a thrown
   * `verify` is fail-closed: the caller MUST treat it as a denial, and a host serving requests over this
   * port MUST map it to a 5xx response (never to a 2xx, and never to the same client-visible shape as an
   * `{ ok: false }` denial).
   */
  verify(token: string, req: VerifyRequest): Promise<VerifyResult>;
}

/**
 * Persistence for pre-expiry capability revocation. Not part of `AuthzPort` itself — revocation is
 * exposed as an extension method on a concrete port (e.g. `HmacAuthzPort.revokeCapability`), the same
 * way `storage-postgres` exposes `ready()` alongside `StoragePort`. A port's `verify` consults a store
 * like this one, keyed by the `jti` carried in its own token payload.
 *
 * This type lives here (spec-core), not in an adapter package, because it is a framework-boundary port
 * type consumed by multiple same-layer packages (authz-hmac, storage-redis, storage-postgres,
 * port-contracts): `spec/test/dependency-direction.test.ts` forbids a dependency on a same-or-later
 * layer, so defining it inside any one of them would make the others unable to depend on it.
 */
export interface CapabilityRevocationStore {
  /** Records jti as revoked until expiresAt (epoch seconds); the store may drop the entry after that. */
  revoke(jti: string, expiresAt: number): Promise<void>;
  /** Whether jti is currently revoked. Behavior after its expiresAt has passed is unspecified (the entry may or may not have been dropped). */
  isRevoked(jti: string): Promise<boolean>;
  close?(): Promise<void>;
}

/**
 * The result of revoking a capability (a concrete port's `revokeCapability` extension method, e.g.
 * `HmacAuthzPort`). Defined here (not in an adapter package) for the same reason as
 * `CapabilityRevocationStore`: it is a wire-shape type shared by multiple same-layer packages
 * (authz-hmac, port-contracts, and future AuthzPort implementations) that must not depend on one
 * another. `code` lets a caller branch on the failure kind without parsing `reason`; `alreadyExpired`
 * distinguishes "nothing to revoke, the token had already expired" from a genuine no-op success.
 */
export type RevokeCapabilityResult =
  | { ok: true; alreadyExpired?: true }
  | { ok: false; code: "MALFORMED" | "INVALID_SIGNATURE" | "NO_JTI" | "STORE_ERROR"; reason: string };

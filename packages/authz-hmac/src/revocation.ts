import type { CapabilityRevocationStore } from "@kohaku-ui/spec-core";

/**
 * An in-memory CapabilityRevocationStore (Map<jti, expiresAt>). Not shared across processes or
 * instances -- suitable for a single-host deployment or for tests; multi-instance deployments should
 * inject a shared store (e.g. Redis / Postgres) instead.
 *
 * `now` is injectable (defaults to the wall clock) so callers can drive expiry with fake timers.
 * Expired entries are swept opportunistically on `revoke()` and lazily on `isRevoked()`, so the map's
 * size stays bounded by the number of issued-but-not-yet-expired revoked tokens.
 */
export function createMemoryRevocationStore(
  now: () => number = () => Math.floor(Date.now() / 1000),
): CapabilityRevocationStore {
  const revoked = new Map<string, number>();

  function sweepExpired(): void {
    const nowSeconds = now();
    for (const [jti, expiresAt] of revoked) {
      if (expiresAt <= nowSeconds) revoked.delete(jti);
    }
  }

  return {
    async revoke(jti, expiresAt) {
      sweepExpired();
      revoked.set(jti, expiresAt);
    },
    async isRevoked(jti) {
      const expiresAt = revoked.get(jti);
      if (expiresAt == null) return false;
      if (expiresAt <= now()) {
        revoked.delete(jti);
        return false;
      }
      return true;
    },
  };
}

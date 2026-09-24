import type { CapabilityRevocationStore } from "@kohaku-ui/spec-core";
import { nowSeconds } from "./time.js";

/**
 * Test-only hooks for `createMemoryRevocationStore`, never used by a production caller.
 */
export interface MemoryRevocationStoreTestHooks {
  /**
   * Injects the backing `Map` so a test can assert eviction (the `sweepExpired` call inside `revoke()`)
   * directly on the Map's contents. Reading through `isRevoked` would itself delete an expired entry as a
   * side effect of the read (see its own lazy check below), which would make an assertion pass even if
   * `sweepExpired()` were deleted from `revoke()` -- inspecting the injected Map instead of calling
   * `isRevoked` avoids that false confidence.
   */
  map?: Map<string, number>;
}

/**
 * An in-memory CapabilityRevocationStore (Map<jti, expiresAt>). Not shared across processes or
 * instances -- suitable for a single-host deployment or for tests; multi-instance deployments should
 * inject a shared store (e.g. Redis / Postgres) instead.
 *
 * `now` is injectable (defaults to the wall clock, in epoch seconds) so callers can drive expiry with fake
 * timers. Expired entries are swept opportunistically on `revoke()` and lazily on `isRevoked()`, so the
 * map's size stays bounded by the number of issued-but-not-yet-expired revoked tokens.
 */
export function createMemoryRevocationStore(
  now: () => number = nowSeconds,
  testHooks: MemoryRevocationStoreTestHooks = {},
): CapabilityRevocationStore {
  const revoked = testHooks.map ?? new Map<string, number>();

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

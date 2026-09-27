import type { ApprovalStore } from "@kohaku-ui/spec-core";
import { nowSeconds } from "./time.js";

/**
 * An in-memory `ApprovalStore` (Map<jti, expiresAt>). Not shared across processes or instances --
 * suitable for a single-host deployment or for tests; a multi-instance deployment should inject a
 * shared store instead (mirrors `createMemoryRevocationStore`'s own caveat).
 *
 * `now` is injectable (defaults to the wall clock, in epoch seconds) so callers can drive expiry with
 * fake timers. Expired entries are swept opportunistically on every `consume()` call, so the map's size
 * stays bounded by the number of issued-but-not-yet-expired consumed tokens. Sweeping before the
 * consumption check is safe even for the jti being consumed: `verifyApproval` only ever calls `consume`
 * after confirming the token itself has not expired, so a sweep can only ever remove *other*,
 * already-expired entries -- never the one currently being checked.
 */
export function createMemoryApprovalStore(now: () => number = nowSeconds): ApprovalStore {
  const consumed = new Map<string, number>();

  function sweepExpired(): void {
    const nowSecondsValue = now();
    for (const [jti, expiresAt] of consumed) {
      if (expiresAt <= nowSecondsValue) consumed.delete(jti);
    }
  }

  return {
    async consume(jti, expiresAt) {
      sweepExpired();
      if (consumed.has(jti)) return false;
      consumed.set(jti, expiresAt);
      return true;
    },
  };
}

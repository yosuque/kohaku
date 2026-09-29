import type { ApprovalStore } from "@kohaku-ui/spec-core";
import { nowSeconds } from "./time.js";

/** Minimum spacing, in seconds, between two full sweeps of the consumed-token map. */
const SWEEP_INTERVAL_SECONDS = 1;

/**
 * An in-memory `ApprovalStore` (Map<jti, expiresAt>). Not shared across processes or instances --
 * suitable for a single-host deployment or for tests; a multi-instance deployment should inject a
 * shared store instead (mirrors `createMemoryRevocationStore`'s own caveat).
 *
 * `now` is injectable (defaults to the wall clock, in epoch seconds) so callers can drive expiry with
 * fake timers. Expired entries are swept opportunistically from `consume()`, at most once per
 * `SWEEP_INTERVAL_SECONDS` (a full-map scan on every call would make each verification O(n) in the number of
 * live consumed tokens), so the map's size stays bounded by the tokens consumed within that window plus the
 * not-yet-expired ones. Throttling the sweep does not loosen the semantics: an entry that has expired but has
 * not been swept yet no longer counts as consumed, so the answer for any jti is exactly what an eager sweep
 * would have given.
 */
export function createMemoryApprovalStore(now: () => number = nowSeconds): ApprovalStore {
  const consumed = new Map<string, number>();
  let lastSweep = Number.NEGATIVE_INFINITY;

  function sweepExpired(nowSecondsValue: number): void {
    if (nowSecondsValue - lastSweep < SWEEP_INTERVAL_SECONDS) return;
    lastSweep = nowSecondsValue;
    for (const [jti, expiresAt] of consumed) {
      if (expiresAt <= nowSecondsValue) consumed.delete(jti);
    }
  }

  return {
    async consume(jti, expiresAt) {
      const nowSecondsValue = now();
      sweepExpired(nowSecondsValue);
      const previous = consumed.get(jti);
      if (previous != null && previous > nowSecondsValue) return false;
      consumed.set(jti, expiresAt);
      return true;
    },
  };
}

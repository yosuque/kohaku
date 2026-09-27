import type { RateLimitStore } from "@kohaku-ui/spec-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContractFixture } from "./storage.js";

/**
 * The RateLimitStore contract (spec-core ports.ts): token-bucket capacity/refill semantics, key
 * independence, and a positive `retryAfterMs` on denial. Registers one `describe` block; call it at
 * the top level of a vitest file.
 *
 * Unlike `describeStoragePortContract`/`describeAuthzPortContract`, this suite does not fake global
 * time: `RateLimitStore.take` takes `nowMs` as an explicit argument (a pure function of its arguments,
 * per the port's own doc comment), so every scenario below drives time purely through that parameter —
 * no `vi.useFakeTimers()`/real-clock option is needed even for a backing store whose actual refill
 * math runs server-side (e.g. a future Redis adapter), as long as it honors the `nowMs` it is given
 * rather than reading its own clock.
 */
export function describeRateLimitStorePortContract(
  name: string,
  factory: () => Promise<ContractFixture<RateLimitStore>> | ContractFixture<RateLimitStore>,
): void {
  describe(`RateLimitStore contract: ${name}`, () => {
    let fixture: ContractFixture<RateLimitStore>;
    let store: RateLimitStore;

    beforeEach(async () => {
      fixture = await factory();
      store = fixture.port;
    });

    afterEach(async () => {
      await fixture.dispose?.();
    });

    it("allows up to capacity, then denies", async () => {
      const rule = { capacity: 3, refillPerSecond: 1 };
      for (let i = 0; i < 3; i++) {
        expect((await store.take("k1", 1, rule, 0)).allow).toBe(true);
      }
      expect((await store.take("k1", 1, rule, 0)).allow).toBe(false);
    });

    it("a denial carries a positive retryAfterMs", async () => {
      const rule = { capacity: 1, refillPerSecond: 1 };
      await store.take("k2", 1, rule, 0);
      const denied = await store.take("k2", 1, rule, 0);
      expect(denied.allow).toBe(false);
      expect(denied.retryAfterMs).toBeGreaterThan(0);
    });

    it("refills over elapsed time (per the nowMs argument, not the wall clock)", async () => {
      const rule = { capacity: 1, refillPerSecond: 1 }; // 1 token/sec
      await store.take("k3", 1, rule, 0);
      expect((await store.take("k3", 1, rule, 0)).allow).toBe(false);
      expect((await store.take("k3", 1, rule, 2000)).allow).toBe(true); // 2s later
    });

    it("never exceeds capacity even after a very long idle period", async () => {
      const rule = { capacity: 2, refillPerSecond: 1 };
      await store.take("k4", 2, rule, 0); // drain to 0
      expect((await store.take("k4", 3, rule, 1_000_000)).allow).toBe(false); // capped at 2, cost 3 still denied
      expect((await store.take("k4", 2, rule, 1_000_000)).allow).toBe(true);
    });

    it("distinct keys are independent buckets", async () => {
      const rule = { capacity: 1, refillPerSecond: 1 };
      expect((await store.take("a", 1, rule, 0)).allow).toBe(true);
      expect((await store.take("a", 1, rule, 0)).allow).toBe(false);
      expect((await store.take("b", 1, rule, 0)).allow).toBe(true); // unaffected by "a"
    });

    it("a zero-capacity rule denies from the first call", async () => {
      const rule = { capacity: 0, refillPerSecond: 1 };
      expect((await store.take("k5", 1, rule, 0)).allow).toBe(false);
    });
  });
}

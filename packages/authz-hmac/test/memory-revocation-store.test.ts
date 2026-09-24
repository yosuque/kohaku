import { describeRevocationStoreContract } from "@kohaku-ui/port-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRevocationStore } from "../src/index.js";

describeRevocationStoreContract("createMemoryRevocationStore", () => ({
  port: createMemoryRevocationStore(),
}));

// Implementation-specific behavior (not part of the shared contract, which deliberately leaves this
// unspecified): the in-memory store actually drops expired entries so its size stays bounded by the
// number of issued-but-not-yet-expired tokens.
describe("createMemoryRevocationStore expired-entry cleanup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sweeps an expired entry out of the map on the next revoke() call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const now = () => Math.floor(Date.now() / 1000);
    const store = createMemoryRevocationStore(now);

    await store.revoke("short-lived", now() + 1);
    expect(await store.isRevoked("short-lived")).toBe(true);

    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    // isRevoked on the now-expired entry reports false ...
    expect(await store.isRevoked("short-lived")).toBe(false);

    // ... and revoking a fresh jti sweeps the stale one out rather than accumulating it forever.
    await store.revoke("another", now() + 3600);
    expect(await store.isRevoked("short-lived")).toBe(false);
    expect(await store.isRevoked("another")).toBe(true);
  });

  // The test above's `isRevoked` calls each delete an expired entry themselves as a side effect of reading
  // it (see the store's own lazy check), so it would still pass even with sweepExpired() deleted from
  // revoke() -- it is not actually pinning the sweep. This test injects the backing Map (a test-only hook,
  // never used by a production caller) and inspects it directly, without any intervening isRevoked call, so
  // deleting the sweepExpired() call inside revoke() makes this assertion fail.
  it("actually evicts an expired entry from the underlying Map on revoke() (not merely via isRevoked's own lazy check)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const now = () => Math.floor(Date.now() / 1000);
    const map = new Map<string, number>();
    const store = createMemoryRevocationStore(now, { map });

    await store.revoke("short-lived", now() + 1);
    expect(map.size).toBe(1);

    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    // No isRevoked call here -- only revoke(), so the eviction below can only be sweepExpired()'s doing.
    await store.revoke("another", now() + 3600);

    expect(map.has("short-lived")).toBe(false);
    expect(map.has("another")).toBe(true);
    expect(map.size).toBe(1);
  });
});

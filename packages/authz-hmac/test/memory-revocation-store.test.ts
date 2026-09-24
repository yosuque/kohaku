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
});

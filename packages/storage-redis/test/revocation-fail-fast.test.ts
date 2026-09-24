import { describe, expect, it } from "vitest";
import { createRedisRevocationStore } from "../src/index.js";

/**
 * Docker-free: mirrors fail-fast.test.ts's proof for the storage port, but for
 * `createRedisRevocationStore`. A port built against an address nothing listens on must fail fast (see
 * revocation.ts's `ready()` doc comment) instead of hanging behind ioredis's default
 * `enableOfflineQueue: true`. See fail-fast.test.ts for why the race is tagged rather than raced as plain
 * promises (a bare `Promise.race` + `.rejects.toThrow()` would be satisfied just as well by the backstop
 * firing under a regression to hanging).
 */
const UNREACHABLE_URL = "redis://127.0.0.1:1";
const CONNECT_TIMEOUT_MS = 200;
const RACE_BUDGET_MS = 2000;

type Settled<T> = { source: "real"; result: PromiseSettledResult<T> } | { source: "backstop-timeout" };

function raceAgainstHang<T>(promise: Promise<T>): Promise<Settled<T>> {
  const real: Promise<Settled<T>> = promise.then(
    (value): Settled<T> => ({ source: "real", result: { status: "fulfilled", value } }),
    (reason): Settled<T> => ({ source: "real", result: { status: "rejected", reason } }),
  );
  const backstop: Promise<Settled<T>> = new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ source: "backstop-timeout" }), RACE_BUDGET_MS);
    timer.unref?.();
  });
  return Promise.race([real, backstop]);
}

function expectFastRejection<T>(outcome: Settled<T>, messagePattern: RegExp): void {
  if (outcome.source !== "real") {
    throw new Error(
      "the real call did not settle within the race budget -- regressed to hanging? " +
        "(the backstop timer fired instead)",
    );
  }
  expect(outcome.result.status).toBe("rejected");
  if (outcome.result.status !== "rejected") return;
  expect(String(outcome.result.reason)).toMatch(messagePattern);
}

describe("createRedisRevocationStore: fail-fast against an unreachable Redis", () => {
  it("ready() rejects within the race budget instead of hanging", async () => {
    const store = createRedisRevocationStore({ url: UNREACHABLE_URL, connectTimeoutMs: CONNECT_TIMEOUT_MS });
    try {
      const outcome = await raceAgainstHang(store.ready());
      expectFastRejection(outcome, /redis revocation store is not ready/i);
    } finally {
      await store.close();
    }
  });

  it("isRevoked() rejects within the race budget instead of hanging behind the offline queue", async () => {
    const store = createRedisRevocationStore({ url: UNREACHABLE_URL, connectTimeoutMs: CONNECT_TIMEOUT_MS });
    try {
      const outcome = await raceAgainstHang(store.isRevoked("some-jti"));
      expectFastRejection(outcome, /redis revocation store is not ready/i);
    } finally {
      await store.close();
    }
  });

  it("revoke() rejects within the race budget instead of hanging behind the offline queue", async () => {
    const store = createRedisRevocationStore({ url: UNREACHABLE_URL, connectTimeoutMs: CONNECT_TIMEOUT_MS });
    try {
      const outcome = await raceAgainstHang(store.revoke("some-jti", Math.floor(Date.now() / 1000) + 3600));
      expectFastRejection(outcome, /redis revocation store is not ready/i);
    } finally {
      await store.close();
    }
  });
});

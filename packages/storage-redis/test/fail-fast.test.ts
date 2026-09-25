import { describe, expect, it } from "vitest";
import { createRedisStoragePort } from "../src/index.js";

/**
 * Docker-free: a port built against an address nothing listens on must fail fast (see
 * redis-storage-port.ts's `ready()` doc comment) instead of hanging behind ioredis's default
 * `enableOfflineQueue: true`.
 *
 * Each assertion races the real call against a generous 2s backstop timer so a regression back to
 * the hanging behavior fails this test outright instead of stalling the whole suite -- a bare `await`
 * on the real call would hang forever under that regression. Critically, the two race branches are
 * tagged (`Settled<T>`) rather than raced as plain promises: a bare `Promise.race([real, timeoutThatRejects])`
 * combined with a bare `.rejects.toThrow()` would be satisfied by the *backstop's own* rejection just as
 * well as by the real call failing fast -- so under a regression to hanging, the backstop would fire,
 * the assertion would still pass (two seconds slower, silently), and this test would have lost its one
 * purpose. Tagging which branch actually settled first, and asserting it was the real call (not the
 * backstop), closes that hole. See "Fix round 1" in followup-4-report.md for the deliberately-regressed
 * proof that this version of the test does fail when the hang is reintroduced.
 */
const UNREACHABLE_URL = "redis://127.0.0.1:1";
const CONNECT_TIMEOUT_MS = 200;
const RACE_BUDGET_MS = 2000;

type Settled<T> = { source: "real"; result: PromiseSettledResult<T> } | { source: "backstop-timeout" };

/**
 * Races the real call against a backstop timer, but never lets the backstop's own settlement be
 * mistaken for the real call's: both branches resolve (never reject) to a tagged `Settled<T>`
 * descriptor, so the caller can assert *which one* won, not just that *something* settled.
 */
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

/** Asserts the real call won the race (not the backstop) and rejected with the given message pattern. */
function expectFastRejection<T>(outcome: Settled<T>, messagePattern: RegExp): void {
  if (outcome.source !== "real") {
    throw new Error(
      "the real call did not settle within the race budget -- regressed to hanging? " +
        "(the backstop timer fired instead)",
    );
  }
  expect(outcome.result.status).toBe("rejected");
  if (outcome.result.status !== "rejected") return; // unreachable after the assertion above; narrows for TS
  expect(String(outcome.result.reason)).toMatch(messagePattern);
}

describe("createRedisStoragePort: fail-fast against an unreachable Redis", () => {
  it("ready() rejects within the race budget instead of hanging", async () => {
    const port = createRedisStoragePort({ url: UNREACHABLE_URL, connectTimeoutMs: CONNECT_TIMEOUT_MS });
    try {
      const outcome = await raceAgainstHang(port.ready());
      expectFastRejection(outcome, /redis storage port is not ready/i);
    } finally {
      await port.close();
    }
  });

  it("getSpecCache() rejects within the race budget instead of hanging behind the offline queue", async () => {
    const port = createRedisStoragePort({ url: UNREACHABLE_URL, connectTimeoutMs: CONNECT_TIMEOUT_MS });
    try {
      const outcome = await raceAgainstHang(port.getSpecCache("some-key"));
      // getSpecCache awaits ready() first, so it fails with the same "not ready" story, not some
      // unrelated command-level error -- this is what makes the assertion specific to *why* it
      // rejected, not merely that it did.
      expectFastRejection(outcome, /redis storage port is not ready/i);
    } finally {
      await port.close();
    }
  });
});

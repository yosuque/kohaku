import { describe, expect, it } from "vitest";
import { createRedisStoragePort } from "../src/index.js";

/**
 * Docker-free: a port built against an address nothing listens on must fail fast (see
 * redis-storage-port.ts's `ready()` doc comment) instead of hanging behind ioredis's default
 * `enableOfflineQueue: true`. Each assertion races the real call against a generous 2s timer so a
 * regression back to the hanging behavior fails this test outright instead of stalling the whole
 * suite -- a bare `await` on the real call would hang forever under that regression.
 */
const UNREACHABLE_URL = "redis://127.0.0.1:1";
const CONNECT_TIMEOUT_MS = 200;
const RACE_BUDGET_MS = 2000;

function raceAgainstHang<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`did not settle within ${RACE_BUDGET_MS}ms (regressed to hanging?)`)),
        RACE_BUDGET_MS,
      );
      timer.unref?.();
    }),
  ]);
}

describe("createRedisStoragePort: fail-fast against an unreachable Redis", () => {
  it("ready() rejects within the race budget instead of hanging", async () => {
    const port = createRedisStoragePort({ url: UNREACHABLE_URL, connectTimeoutMs: CONNECT_TIMEOUT_MS });
    try {
      await expect(raceAgainstHang(port.ready())).rejects.toThrow();
    } finally {
      await port.close();
    }
  });

  it("getSpecCache() rejects within the race budget instead of hanging behind the offline queue", async () => {
    const port = createRedisStoragePort({ url: UNREACHABLE_URL, connectTimeoutMs: CONNECT_TIMEOUT_MS });
    try {
      await expect(raceAgainstHang(port.getSpecCache("some-key"))).rejects.toThrow();
    } finally {
      await port.close();
    }
  });
});

import { describeStoragePortContract } from "@kohaku-ui/port-contracts";
import { afterAll, describe } from "vitest";
import { createRedisStoragePort } from "../src/index.js";
import { backend, startRedis, uniquePrefix } from "./backend.js";

// The shared StoragePort contract (P0) against a real Redis. Skipped without a backend (see backend.ts).
//
// The container/URL is resolved ONCE for the whole file (module-level, memoized), not per test: the shared
// contract's `factory` runs inside `beforeEach` for every test in the suite (well over a dozen), so starting
// a fresh container per test would mean minutes of wall clock and near-certain timeouts. `factory` here only
// creates a fresh `RedisStoragePort` (a new key prefix keeps every test's keys isolated); `dispose` closes
// just that port. The container itself is stopped once, in `afterAll`.
//
// `clock: "real"` is required because Redis expiry (`SET … EX`) happens server-side: the suite's default
// fake-timer clock can't move it, so the TTL test needs an actual ~1.1s wait instead.
let started: Awaited<ReturnType<typeof startRedis>> | undefined;

async function sharedBackend() {
  if (started == null) started = await startRedis();
  return started;
}

describe.skipIf(backend.mode === "skip")("storage-redis contract", () => {
  afterAll(async () => {
    await started?.stop();
    started = undefined;
  });

  describeStoragePortContract(
    "redis",
    async () => {
      const { url } = await sharedBackend();
      const port = createRedisStoragePort({ url, keyPrefix: uniquePrefix() });
      return {
        port,
        dispose: async () => {
          await port.close();
        },
      };
    },
    { clock: "real" },
  );
});

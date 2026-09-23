import { describeRevocationStoreContract } from "@kohaku-ui/port-contracts";
import { afterAll, describe } from "vitest";
import { createRedisRevocationStore } from "../src/index.js";
import { backend, startRedis, uniquePrefix } from "./backend.js";

// The shared CapabilityRevocationStore contract (A4) against a real Redis. Skipped without a backend (see
// backend.ts). The container/URL is resolved once for the whole file, same reasoning as contract.test.ts.
let started: Awaited<ReturnType<typeof startRedis>> | undefined;

async function sharedBackend() {
  if (started == null) started = await startRedis();
  return started;
}

describe.skipIf(backend.mode === "skip")("storage-redis CapabilityRevocationStore contract", () => {
  afterAll(async () => {
    await started?.stop();
    started = undefined;
  });

  describeRevocationStoreContract("redis", async () => {
    const { url } = await sharedBackend();
    const store = createRedisRevocationStore({ url, keyPrefix: uniquePrefix() });
    return {
      port: store,
      dispose: async () => {
        await store.close();
      },
    };
  });
});

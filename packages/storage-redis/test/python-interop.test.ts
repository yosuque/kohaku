import { describeStoragePythonInterop } from "@kohaku-ui/port-contracts";
import { afterAll } from "vitest";
import { createRedisRevocationStore, createRedisStoragePort } from "../src/index.js";
import { backend, startRedis, uniquePrefix } from "./backend.js";

// The Python storage adapter (python/kohaku/src/kohaku/storage/redis) must be able to share one Redis with this
// one: each side reads what the other wrote and compare-and-sets it forward. The Python half runs in a child
// process (python/kohaku/tests/storage/interop_peer.py); the suite skips without a backend, and without the Python
// workspace venv unless KOHAKU_ADAPTER_TESTS=require (see port-contracts' python-peer.ts).
let started: Awaited<ReturnType<typeof startRedis>> | undefined;

afterAll(async () => {
  await started?.stop();
  started = undefined;
});

describeStoragePythonInterop("storage-redis", {
  backend: "redis",
  skip: backend.mode === "skip",
  url: async () => {
    started ??= await startRedis();
    return started.url;
  },
  namespace: uniquePrefix,
  open: async (url, keyPrefix) => {
    const storage = createRedisStoragePort({ url, keyPrefix });
    const revocations = createRedisRevocationStore({ url, keyPrefix });
    return {
      storage,
      revocations,
      close: async () => {
        await storage.close();
        await revocations.close();
      },
    };
  },
});

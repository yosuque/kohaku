import { describeStoragePythonInterop } from "@kohaku-ui/port-contracts";
import { afterAll } from "vitest";
import { createPostgresRevocationStore, createPostgresStoragePort } from "../src/index.js";
import { backend, startPostgres, uniqueSchema } from "./backend.js";

// The Python storage adapter (python/kohaku/src/kohaku/storage/postgres) must be able to share one database with
// this one: both migrate the same schema under the same advisory lock, and each side reads what the other wrote and
// compare-and-sets it forward. The Python half runs in a child process (python/kohaku/tests/storage/
// interop_peer.py); the suite skips without a backend, and without the Python workspace venv unless
// KOHAKU_ADAPTER_TESTS=require (see port-contracts' python-peer.ts).
let started: Awaited<ReturnType<typeof startPostgres>> | undefined;

afterAll(async () => {
  await started?.stop();
  started = undefined;
});

describeStoragePythonInterop("storage-postgres", {
  backend: "postgres",
  skip: backend.mode === "skip",
  url: async () => {
    started ??= await startPostgres();
    return started.connectionString;
  },
  namespace: uniqueSchema,
  open: async (connectionString, schema) => {
    const storage = createPostgresStoragePort({ connectionString, schema });
    const revocations = createPostgresRevocationStore({ connectionString, schema });
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

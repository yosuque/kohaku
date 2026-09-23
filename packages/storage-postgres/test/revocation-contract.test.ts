import { describeRevocationStoreContract } from "@kohaku-ui/port-contracts";
import { afterAll, describe } from "vitest";
import { createPostgresRevocationStore } from "../src/index.js";
import { backend, startPostgres, uniqueSchema } from "./backend.js";

// The shared CapabilityRevocationStore contract (A4) against a real Postgres. Skipped without a backend
// (see backend.ts). Container/URL resolved once for the whole file, same reasoning as contract.test.ts.
let started: Awaited<ReturnType<typeof startPostgres>> | undefined;

async function sharedBackend() {
  if (started == null) started = await startPostgres();
  return started;
}

describe.skipIf(backend.mode === "skip")("storage-postgres CapabilityRevocationStore contract", () => {
  afterAll(async () => {
    await started?.stop();
    started = undefined;
  });

  describeRevocationStoreContract("postgres", async () => {
    const { connectionString } = await sharedBackend();
    const store = createPostgresRevocationStore({ connectionString, schema: uniqueSchema() });
    return {
      port: store,
      dispose: async () => {
        await store.close();
      },
    };
  });
});

import { describeStoragePortContract } from "@kohaku-ui/port-contracts";
import { afterAll, describe } from "vitest";
import { createPostgresStoragePort } from "../src/index.js";
import { backend, startPostgres, uniqueSchema } from "./backend.js";

// The shared StoragePort contract (P0) against a real Postgres. Skipped without a backend (see backend.ts).
//
// The container/URL is resolved ONCE for the whole file (module-level, memoized), not per test: the shared
// contract's `factory` runs inside `beforeEach` for every test in the suite (well over a dozen), so starting
// a fresh container per test would mean minutes of wall clock and near-certain timeouts. `factory` here only
// creates a fresh `PostgresStoragePort` (a new schema keeps every test's rows isolated); `dispose` closes
// just that port. The container itself is stopped once, in `afterAll`.
//
// `clock: "real"` is required because Postgres evaluates `expires_at > now()` server-side: the suite's default
// fake-timer clock can't move it, so the TTL test needs an actual wait instead.
let started: Awaited<ReturnType<typeof startPostgres>> | undefined;

async function sharedBackend() {
  if (started == null) started = await startPostgres();
  return started;
}

describe.skipIf(backend.mode === "skip")("storage-postgres contract", () => {
  afterAll(async () => {
    await started?.stop();
    started = undefined;
  });

  describeStoragePortContract(
    "postgres",
    async () => {
      const { connectionString } = await sharedBackend();
      const port = createPostgresStoragePort({ connectionString, schema: uniqueSchema() });
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

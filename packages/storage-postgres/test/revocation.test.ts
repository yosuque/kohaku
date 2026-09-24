import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPostgresRevocationStore, type PostgresRevocationStore } from "../src/index.js";
import { backend, startPostgres, uniqueSchema } from "./backend.js";

// Behavior specific to the Postgres adapter, beyond the shared CapabilityRevocationStore contract
// (revocation-contract.test.ts): upsert semantics and sweepExpiredRevocations().
describe.skipIf(backend.mode === "skip")("createPostgresRevocationStore", () => {
  let stop: () => Promise<void>;
  let connectionString: string;
  let store: PostgresRevocationStore;
  const schema = uniqueSchema();

  beforeAll(async () => {
    const started = await startPostgres();
    connectionString = started.connectionString;
    stop = started.stop;
    store = createPostgresRevocationStore({ connectionString, schema });
    await store.ready();
  });

  afterAll(async () => {
    await store.close();
    await stop();
  });

  afterEach(async () => {
    await store.sweepExpiredRevocations();
  });

  it("revoke() upserts: revoking the same jti again updates its expiry rather than erroring", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    await store.revoke("dup-jti", nowSeconds + 60);
    await store.revoke("dup-jti", nowSeconds + 3600);
    expect(await store.isRevoked("dup-jti")).toBe(true);
  });

  it("sweepExpiredRevocations() deletes rows whose expires_at has passed and returns the row count", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    await store.revoke("sweep-me", nowSeconds - 10);
    await store.revoke("keep-me", nowSeconds + 3600);

    const deleted = await store.sweepExpiredRevocations();
    expect(deleted).toBe(1);
    expect(await store.isRevoked("keep-me")).toBe(true);
  });
});

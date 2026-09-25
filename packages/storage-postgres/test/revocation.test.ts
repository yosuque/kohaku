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

  it("isRevoked reports false for a jti revoked with an already-past expiresAt, before any sweep", async () => {
    const alreadyExpired = Math.floor(Date.now() / 1000) - 3600;
    await store.revoke("born-expired", alreadyExpired);
    // No sweepExpiredRevocations() call here: `isRevoked`'s own `expires_at > now()` filter must
    // already treat the row as not-revoked, independent of the sweep cron ever running.
    expect(await store.isRevoked("born-expired")).toBe(false);
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

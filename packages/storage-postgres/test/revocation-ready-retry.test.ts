import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createPostgresRevocationStore } from "../src/index.js";

// Mirrors spec-cache.test.ts's "does not cache a rejected migration" proof, but for
// createPostgresRevocationStore's own ready() gate: a `ready()` that memoized a rejection forever would
// reintroduce a bug this branch has already fixed twice for storage-redis (see revocation.ts's doc
// comment) -- exercised here for the Postgres store's analogous gate. No backend needed: this mocks
// `pg.Pool`, so it always runs even without Docker.
describe("createPostgresRevocationStore: ready() after a failed migration", () => {
  it("does not cache a rejected migration — the next call retries the DDL from scratch", async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient migration failure"))
      .mockResolvedValue({ rows: [], rowCount: 0 });
    const fakePool = { query } as unknown as Pool;
    const store = createPostgresRevocationStore({ pool: fakePool, schema: "retry_test" });

    await expect(store.ready()).rejects.toThrow("transient migration failure");
    expect(query).toHaveBeenCalledTimes(1);

    await expect(store.ready()).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(3);
  });
});

import type { UISpec } from "@kohaku-ui/spec-core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresStoragePort, POSTGRES_SCHEMA_VERSION, qualifiedTable } from "../src/index.js";
import { backend, startPostgres, uniqueSchema } from "./backend.js";

// Backend behavior specific to `kohaku_schema_meta` and the advisory-lock-guarded migration
// (connection.ts's `migrateSchema`): a real Postgres is needed for both -- the version check runs a
// real query against a real table, and the concurrent-migration case only means anything against a
// real database two real connections can race against.
describe.skipIf(backend.mode === "skip")("createPostgresStoragePort: schema versioning", () => {
  let stop: () => Promise<void>;
  let connectionString: string;

  beforeAll(async () => {
    const started = await startPostgres();
    connectionString = started.connectionString;
    stop = started.stop;
  });
  afterAll(async () => {
    await stop();
  });

  it("fails ready() with both the expected and found version when a deployed schema is on a different version", async () => {
    const schema = uniqueSchema();
    const first = createPostgresStoragePort({ connectionString, schema });
    await first.ready();
    await first.close();

    const pool = new Pool({ connectionString });
    try {
      await pool.query(`UPDATE ${qualifiedTable(schema, "kohaku_schema_meta")} SET version = 999`);
    } finally {
      await pool.end();
    }

    const second = createPostgresStoragePort({ connectionString, schema });
    await expect(second.ready()).rejects.toThrow(
      new RegExp(`${POSTGRES_SCHEMA_VERSION}.*999|999.*${POSTGRES_SCHEMA_VERSION}`),
    );
    await second.close();
  });

  it("fails ready() when a pre-existing kohaku_lineage table lacks a unique constraint/index on id (README step 2)", async () => {
    // Simulates a pre-release deployment (predates kohaku_schema_meta) that skipped the README's
    // "Migrating from a pre-release schema" step 2. CREATE TABLE IF NOT EXISTS leaves this table
    // exactly as-is, so ready()'s first-stamp check must catch the missing constraint itself rather
    // than let appendLineage's ON CONFLICT (id) fail at runtime later.
    const schema = uniqueSchema();
    const pool = new Pool({ connectionString });
    try {
      await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      await pool.query(`
        CREATE TABLE "${schema}"."kohaku_lineage" (
          seq bigserial PRIMARY KEY,
          id text NOT NULL,
          ts text NOT NULL,
          tenant text NOT NULL DEFAULT '',
          type text NOT NULL,
          intent_hash text NULL,
          artifact_id text NULL,
          spec_hash text NULL,
          record text NOT NULL
        )
      `);
    } finally {
      await pool.end();
    }

    const port = createPostgresStoragePort({ connectionString, schema });
    await expect(port.ready()).rejects.toThrow(/unique constraint\/index on "id"/);
    await port.close();
  });

  it("two ports calling ready() concurrently on a fresh schema both succeed (the advisory lock serializes the DDL)", async () => {
    const schema = uniqueSchema();
    const a = createPostgresStoragePort({ connectionString, schema });
    const b = createPostgresStoragePort({ connectionString, schema });
    try {
      await expect(Promise.all([a.ready(), b.ready()])).resolves.toEqual([undefined, undefined]);

      // Both ports are left usable against the one, once-migrated schema.
      const spec = { key: "concurrent-ready" } as unknown as UISpec;
      await a.putSpecCache("k", spec);
      expect(await b.getSpecCache("k")).toEqual(spec);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

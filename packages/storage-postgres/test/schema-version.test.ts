import type { UISpec } from "@kohaku-ui/spec-core";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresStoragePort, POSTGRES_SCHEMA_VERSION, qualifiedTable } from "../src/index.js";
import { lineageCorrelationDdl } from "../src/schema.js";
import { backend, startPostgres, uniqueSchema } from "./backend.js";

/** Wraps `pool.query` and every checked-out client's `query` so a test can see each statement issued. */
function recordStatements(pool: Pool): string[] {
  const statements: string[] = [];
  const textOf = (arg: unknown): string =>
    String(typeof arg === "string" ? arg : (arg as { text: string }).text);
  const query = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  (pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
    statements.push(textOf(args[0]));
    return query(...args);
  };
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => Promise<PoolClient>;
  (pool as unknown as { connect: unknown }).connect = async (...args: unknown[]) => {
    // `pool.query` itself calls `connect(callback)`; that path is already recorded at `pool.query`.
    if (typeof args[0] === "function") return connect(...args);
    const client = await connect();
    const clientQuery = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
      statements.push(textOf(args[0]));
      return clientQuery(...args);
    };
    return client;
  };
  return statements;
}

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

  it("upgrades a pre-0.4 kohaku_lineage (no correlation_id) in place, and a second ready() is a no-op", async () => {
    const schema = uniqueSchema();
    const pool = new Pool({ connectionString });
    try {
      await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      await pool.query(`
        CREATE TABLE "${schema}"."kohaku_lineage" (
          seq bigserial PRIMARY KEY,
          id text NOT NULL,
          ts text COLLATE "C" NOT NULL,
          tenant text NOT NULL DEFAULT '',
          type text NOT NULL,
          intent_hash text NULL,
          artifact_id text NULL,
          spec_hash text NULL,
          record text NOT NULL,
          UNIQUE (id)
        )
      `);
      const catalog = async () => {
        const column = await pool.query(
          "SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'kohaku_lineage' AND column_name = 'correlation_id'",
          [schema],
        );
        const index = await pool.query(
          "SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname LIKE '%correlation_id_idx'",
          [schema],
        );
        return [column.rowCount, index.rowCount];
      };
      expect(await catalog()).toEqual([0, 0]);

      const first = createPostgresStoragePort({ connectionString, schema });
      await first.ready();
      await first.close();
      expect(await catalog()).toEqual([1, 1]);

      const spied = new Pool({ connectionString });
      const statements = recordStatements(spied);
      const second = createPostgresStoragePort({ pool: spied, schema });
      await expect(second.ready()).resolves.toBeUndefined();
      await spied.end();
      expect(await catalog()).toEqual([1, 1]);
      // The catalog already had everything, so the second start issued no correlation DDL at all -- no
      // ALTER TABLE (ACCESS EXCLUSIVE) and no index build. Only the base script's own `IF NOT EXISTS`
      // statements still run.
      expect(statements.some((sql) => /ALTER TABLE|correlation_id_idx ON/i.test(sql))).toBe(false);
      expect(statements.some((sql) => /CREATE INDEX CONCURRENTLY|DROP INDEX/i.test(sql))).toBe(false);
    } finally {
      await pool.end();
    }
  });

  it("builds the correlation index without a statement timeout, leaving no session setting on the pooled connection", async () => {
    const schema = uniqueSchema();
    const pool = new Pool({ connectionString, max: 1, statement_timeout: 7000 });
    try {
      await createPostgresStoragePort({ pool, schema }).ready();
      // max: 1 means the very connection that ran the build is the one queried here.
      const { rows } = await pool.query("SHOW statement_timeout");
      expect(rows[0].statement_timeout).toBe("7s");
    } finally {
      await pool.end();
    }
  });

  it("does not re-run correlation DDL on later starts when the schema name is long enough to truncate the index name", async () => {
    const schema = `s${"x".repeat(40)}${uniqueSchema()}`.slice(0, 60);
    const { indexName } = lineageCorrelationDdl(schema);
    expect(`${schema.toLowerCase()}_kohaku_lineage_correlation_id_idx`.length).toBeGreaterThan(63);
    const first = createPostgresStoragePort({ connectionString, schema });
    await first.ready();
    await first.close();

    const pool = new Pool({ connectionString });
    try {
      const found = await pool.query(`SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`, [
        schema,
        indexName,
      ]);
      expect(found.rowCount).toBe(1);

      const spied = new Pool({ connectionString });
      const statements = recordStatements(spied);
      await createPostgresStoragePort({ pool: spied, schema }).ready();
      await spied.end();
      expect(statements.some((sql) => /correlation_id_idx ON|CONCURRENTLY|ADD COLUMN/i.test(sql))).toBe(
        false,
      );
    } finally {
      await pool.end();
    }
  });

  it("drops and rebuilds an INVALID correlation index left behind by a failed concurrent build", async () => {
    const schema = uniqueSchema();
    const ddl = lineageCorrelationDdl(schema);
    const first = createPostgresStoragePort({ connectionString, schema });
    await first.ready();
    for (const id of ["a", "b"]) {
      await first.appendLineage({
        id,
        ts: "2026-01-01T00:00:00.000Z",
        actor: { kind: "system" },
        type: "view.composed",
        payload: { correlationId: "dup" },
      });
    }
    await first.close();

    const pool = new Pool({ connectionString });
    try {
      const table = `"${schema}"."kohaku_lineage"`;
      await pool.query(`DROP INDEX "${schema}"."${ddl.indexName}"`);
      // A unique build over duplicate values fails and leaves the index INVALID under the same name.
      await expect(
        pool.query(`CREATE UNIQUE INDEX CONCURRENTLY ${ddl.indexName} ON ${table} (correlation_id)`),
      ).rejects.toThrow();
      const state = () =>
        pool.query<{ indisvalid: boolean; indisunique: boolean }>(
          "SELECT indisvalid, indisunique FROM pg_index WHERE indexrelid = to_regclass($1)",
          [`"${schema}"."${ddl.indexName}"`],
        );
      expect((await state()).rows).toEqual([{ indisvalid: false, indisunique: true }]);

      const second = createPostgresStoragePort({ connectionString, schema });
      await second.ready();
      await second.close();
      expect((await state()).rows).toEqual([{ indisvalid: true, indisunique: false }]);
    } finally {
      await pool.end();
    }
  });

  it("with migrate: false, fails ready() and appendLineage naming the missing correlation_id DDL, and passes once it is added", async () => {
    const schema = uniqueSchema();
    const pool = new Pool({ connectionString });
    try {
      await createPostgresStoragePort({ pool, schema }).ready();
      await pool.query(`ALTER TABLE "${schema}"."kohaku_lineage" DROP COLUMN correlation_id`);

      const port = createPostgresStoragePort({ pool, schema, migrate: false });
      await expect(port.ready()).rejects.toThrow(/has no correlation_id column[\s\S]*ADD COLUMN/);
      await expect(
        port.appendLineage({
          id: "x",
          ts: "2026-01-01T00:00:00.000Z",
          actor: { kind: "system" },
          type: "view.composed",
          payload: {},
        }),
      ).rejects.toThrow(/Upgrading to 0\.4\.x/);

      await pool.query(`ALTER TABLE "${schema}"."kohaku_lineage" ADD COLUMN correlation_id text NULL`);
      await expect(port.ready()).resolves.toBeUndefined();
    } finally {
      await pool.end();
    }
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

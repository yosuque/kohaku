import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertLineageSchemaCurrent, createPostgresPool } from "../src/connection.js";

// A fully mocked `pg` module: `createPostgresPool` is the single place the owned-`Pool` construction
// (timeouts, `max`, the `error` listener) and the `ready()` migration transaction live, so both are
// unit-tested here once against a fake `pg.Pool` / `pg.PoolClient` rather than duplicated per adapter.
// `vi.mock` is hoisted above these imports by vitest's transform, so `createPostgresPool`'s own
// `import { Pool } from "pg"` resolves to the fake below.
interface FakePool {
  config: unknown;
  on: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
}
const poolInstances: FakePool[] = [];

vi.mock("pg", () => {
  class FakePoolCtor {
    config: unknown;
    on = vi.fn();
    query = vi.fn();
    end = vi.fn().mockResolvedValue(undefined);
    connect = vi.fn();
    constructor(config: unknown) {
      this.config = config;
      poolInstances.push(this as unknown as FakePool);
    }
  }
  return { Pool: FakePoolCtor };
});

function injectedPool(overrides: Partial<FakePool> = {}): Pool {
  return {
    on: vi.fn(),
    query: vi.fn(),
    end: vi.fn(),
    connect: vi.fn(),
    ...overrides,
  } as unknown as Pool;
}

describe("createPostgresPool: option validation", () => {
  it("rejects passing both connectionString and pool", () => {
    expect(() => createPostgresPool({ connectionString: "postgres://x", pool: injectedPool() })).toThrow(
      /pass either `connectionString` or `pool`, not both/,
    );
  });

  it("rejects passing neither connectionString nor pool", () => {
    expect(() => createPostgresPool({})).toThrow(/one of `connectionString` or `pool` is required/);
  });
});

describe("createPostgresPool: owned pool construction", () => {
  it("passes connect/statement timeouts and max through to the Pool constructor", () => {
    poolInstances.length = 0;
    createPostgresPool({
      connectionString: "postgres://example/db",
      connectTimeoutMs: 1234,
      statementTimeoutMs: 5678,
      maxConnections: 9,
    });
    expect(poolInstances).toHaveLength(1);
    expect(poolInstances[0]?.config).toMatchObject({
      connectionString: "postgres://example/db",
      connectionTimeoutMillis: 1234,
      statement_timeout: 5678,
      max: 9,
    });
  });

  it("applies documented defaults when timeouts/max are omitted", () => {
    poolInstances.length = 0;
    createPostgresPool({ connectionString: "postgres://example/db" });
    expect(poolInstances[0]?.config).toMatchObject({
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
    });
    expect(poolInstances[0]?.config).not.toHaveProperty("max");
  });

  it("attaches an error listener to an owned pool and forwards to onError", () => {
    poolInstances.length = 0;
    const onError = vi.fn();
    createPostgresPool({ connectionString: "postgres://example/db", onError });
    const pool = poolInstances[0]!;
    expect(pool.on).toHaveBeenCalledWith("error", expect.any(Function));
    const handler = pool.on.mock.calls[0]![1] as (error: Error) => void;
    const boom = new Error("boom");
    handler(boom);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("logs via console.error (with a clear prefix) when no onError is given", () => {
    poolInstances.length = 0;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      createPostgresPool({ connectionString: "postgres://example/db" });
      const handler = poolInstances[0]!.on.mock.calls[0]![1] as (error: Error) => void;
      const boom = new Error("boom");
      handler(boom);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("@kohaku-ui/storage-postgres"), boom);
    } finally {
      spy.mockRestore();
    }
  });

  it("never constructs a Pool, attaches a listener, or ends an injected pool", async () => {
    poolInstances.length = 0;
    const injected = injectedPool();
    const handle = createPostgresPool({ pool: injected, migrate: false });
    expect(poolInstances).toHaveLength(0);
    expect(injected.on).not.toHaveBeenCalled();
    await handle.close();
    expect(injected.end).not.toHaveBeenCalled();
  });

  it("close() ends an owned pool", async () => {
    poolInstances.length = 0;
    const handle = createPostgresPool({ connectionString: "postgres://example/db", migrate: false });
    await handle.close();
    expect(poolInstances[0]!.end).toHaveBeenCalledTimes(1);
  });
});

/** What the fake catalog says about the lineage table's correlation column and index. */
interface FakeCatalog {
  column: boolean;
  /** `valid` / `invalid` / `missing`, as the index-validity query reports it. */
  index: "valid" | "invalid" | "missing";
}

/**
 * A fake `pg.PoolClient` (also usable as the pool's own `query`) that answers by SQL content and records
 * every statement. `fail` lets a test throw for a statement it matches, once per entry.
 */
function fakeClient(catalog: FakeCatalog, fail: { match: (sql: string) => boolean; error: Error }[] = []) {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string) => {
    statements.push(sql);
    const index = fail.findIndex((f) => f.match(sql));
    if (index >= 0) throw fail.splice(index, 1)[0]!.error;
    if (sql.includes("has_column")) {
      return { rows: [{ has_table: true, has_column: catalog.column }], rowCount: 1 };
    }
    if (sql.includes("indisvalid")) {
      return catalog.index === "missing"
        ? { rows: [], rowCount: 0 }
        : { rows: [{ indisvalid: catalog.index === "valid" }], rowCount: 1 };
    }
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }], rowCount: 1 };
    // The first-stamp path's assertLineageIdIsUnique check (this fake has no real pg_index to query).
    if (sql.includes("indisunique")) return { rows: [{ ok: true }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { client: { query, release: vi.fn() }, statements };
}

describe("createPostgresPool: ready() migration transaction", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not cache a rejected migration -- a later call reconnects and retries from scratch", async () => {
    vi.useFakeTimers();
    const { client } = fakeClient({ column: true, index: "valid" }, [
      { match: (sql) => sql === "BEGIN", error: new Error("transient migration failure") },
    ]);
    const connect = vi.fn().mockResolvedValue(client);
    const handle = createPostgresPool({
      pool: injectedPool({ connect, query: client.query }),
      schema: "retry_test",
    });

    await expect(handle.ready()).rejects.toThrow("transient migration failure");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1001);
    await expect(handle.ready()).resolves.toBeUndefined();
    expect(client.query).toHaveBeenCalledWith("COMMIT");
  });

  it("retries once on a concurrent-DDL race (SQLSTATE 23505 / 42P07) and then succeeds", async () => {
    const race = Object.assign(new Error("duplicate_object"), { code: "42P07" });
    const { client } = fakeClient({ column: true, index: "valid" }, [
      { match: (sql) => sql.includes("CREATE TABLE IF NOT EXISTS"), error: race },
    ]);
    const connect = vi.fn().mockResolvedValue(client);
    const handle = createPostgresPool({
      pool: injectedPool({ connect, query: client.query }),
      schema: "race_test",
    });

    await expect(handle.ready()).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(2); // the raced attempt, then the retry
  });

  describe("retry backoff after a failed ready()", () => {
    async function failingHandle() {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const connect = vi.fn().mockRejectedValue(new Error("connection refused"));
      const handle = createPostgresPool({ pool: injectedPool({ connect }), schema: "backoff_test" });
      return { handle, connect };
    }

    it("rejects calls inside the backoff window with the last error, without touching the database", async () => {
      const { handle, connect } = await failingHandle();
      await expect(handle.ready()).rejects.toThrow("connection refused");
      expect(connect).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(999);
      await expect(handle.ready()).rejects.toThrow("connection refused");
      await expect(handle.ready()).rejects.toThrow("connection refused");
      expect(connect).toHaveBeenCalledTimes(1);
    });

    it("re-runs the migration after the window and doubles the wait per consecutive failure, up to 60 s", async () => {
      const { handle, connect } = await failingHandle();
      await expect(handle.ready()).rejects.toThrow("connection refused");
      let expectedCalls = 1;
      for (const delayMs of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
        // One millisecond short of the wait: still refused without touching the database.
        vi.advanceTimersByTime(delayMs - 1);
        await expect(handle.ready()).rejects.toThrow("connection refused");
        expect(connect).toHaveBeenCalledTimes(expectedCalls);
        // Right at the wait's end: the migration runs again (and fails again).
        vi.advanceTimersByTime(1);
        await expect(handle.ready()).rejects.toThrow("connection refused");
        expect(connect).toHaveBeenCalledTimes(++expectedCalls);
      }
    });

    it("resets the backoff once a migration succeeds", async () => {
      vi.useFakeTimers();
      const { client } = fakeClient({ column: true, index: "valid" }, [
        { match: (sql) => sql === "BEGIN", error: new Error("first failure") },
      ]);
      const connect = vi.fn().mockResolvedValue(client);
      const handle = createPostgresPool({
        pool: injectedPool({ connect, query: client.query }),
        schema: "reset_test",
      });
      await expect(handle.ready()).rejects.toThrow("first failure");
      vi.advanceTimersByTime(1001);
      await expect(handle.ready()).resolves.toBeUndefined();
      // Memoised after success: no further connections.
      const calls = connect.mock.calls.length;
      await expect(handle.ready()).resolves.toBeUndefined();
      expect(connect.mock.calls.length).toBe(calls);
    });
  });

  describe("lineage correlation_id migration", () => {
    async function migrate(catalog: FakeCatalog, schema = "corr_test"): Promise<string[]> {
      const { client, statements } = fakeClient(catalog);
      const injected = injectedPool({ connect: vi.fn().mockResolvedValue(client), query: client.query });
      await createPostgresPool({ pool: injected, schema }).ready();
      return statements;
    }

    it("issues no ALTER TABLE and no correlation index DDL when both already exist and are valid", async () => {
      const statements = await migrate({ column: true, index: "valid" });
      expect(statements.some((sql) => sql.includes("ADD COLUMN"))).toBe(false);
      expect(statements.some((sql) => sql.includes("correlation_id_idx ON"))).toBe(false);
      expect(statements.some((sql) => sql.includes("DROP INDEX"))).toBe(false);
    });

    it("adds the column inside the transaction and builds the index concurrently after COMMIT", async () => {
      const statements = await migrate({ column: false, index: "missing" });
      const alter = statements.indexOf(
        'ALTER TABLE "corr_test"."kohaku_lineage" ADD COLUMN IF NOT EXISTS correlation_id text NULL',
      );
      const commit = statements.indexOf("COMMIT");
      const create = statements.indexOf(
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS corr_test_kohaku_lineage_correlation_id_idx ON "corr_test"."kohaku_lineage" (correlation_id, seq)',
      );
      expect(alter).toBeGreaterThanOrEqual(0);
      expect(commit).toBeGreaterThan(alter);
      expect(create).toBeGreaterThan(commit);
      // No plain (blocking, transactional) index build for it.
      expect(
        statements.some((sql) =>
          sql.startsWith("CREATE INDEX IF NOT EXISTS corr_test_kohaku_lineage_correlation"),
        ),
      ).toBe(false);
    });

    it("builds only the index when the column is there but the index is not", async () => {
      const statements = await migrate({ column: true, index: "missing" });
      expect(statements.some((sql) => sql.includes("ADD COLUMN"))).toBe(false);
      expect(statements.some((sql) => sql.startsWith("CREATE INDEX CONCURRENTLY"))).toBe(true);
      expect(statements.some((sql) => sql.startsWith("DROP INDEX"))).toBe(false);
    });

    it("drops an INVALID leftover concurrently, then rebuilds it", async () => {
      const statements = await migrate({ column: true, index: "invalid" });
      const drop = statements.indexOf(
        'DROP INDEX CONCURRENTLY IF EXISTS "corr_test"."corr_test_kohaku_lineage_correlation_id_idx"',
      );
      const create = statements.findIndex((sql) => sql.startsWith("CREATE INDEX CONCURRENTLY"));
      expect(drop).toBeGreaterThanOrEqual(0);
      expect(create).toBeGreaterThan(drop);
    });

    it("runs the build without a statement timeout, restores it, and serializes on a session advisory lock", async () => {
      const statements = await migrate({ column: true, index: "missing" });
      const setTimeout0 = statements.indexOf("SET statement_timeout = 0");
      const lock = statements.findIndex((sql) => sql.includes("pg_try_advisory_lock"));
      const create = statements.findIndex((sql) => sql.startsWith("CREATE INDEX CONCURRENTLY"));
      const unlock = statements.findIndex((sql) => sql.includes("pg_advisory_unlock"));
      const reset = statements.indexOf("RESET statement_timeout");
      expect(setTimeout0).toBeGreaterThanOrEqual(0);
      expect(lock).toBeGreaterThan(setTimeout0);
      expect(create).toBeGreaterThan(lock);
      expect(unlock).toBeGreaterThan(create);
      expect(reset).toBeGreaterThan(unlock);
    });

    it("looks the index up by catalog name, so a schema long enough to truncate it does not rerun the DDL", async () => {
      const schema = "a_very_long_schema_name_that_pushes_the_index_name_past_63_bytes";
      const { client, statements } = fakeClient({ column: true, index: "valid" });
      const injected = injectedPool({ connect: vi.fn().mockResolvedValue(client), query: client.query });
      await createPostgresPool({ pool: injected, schema }).ready();
      const lookup = client.query.mock.calls.find(([sql]) => String(sql).includes("indisvalid")) as
        | [string, string[]]
        | undefined;
      const indexName = lookup?.[1][0]?.split(".")[1]?.replaceAll('"', "") ?? "";
      expect(indexName).not.toBe("");
      expect(Buffer.byteLength(indexName)).toBeLessThanOrEqual(63);
      expect(statements.some((sql) => sql.startsWith("CREATE INDEX"))).toBe(false);
    });

    it("bounds table-lock waits with a transaction-local lock_timeout, set after the advisory lock", async () => {
      const statements = await migrate({ column: true, index: "valid" });
      const advisory = statements.findIndex((sql) => sql.includes("pg_advisory_xact_lock"));
      const timeout = statements.indexOf("SET LOCAL lock_timeout = 5000");
      const firstDdl = statements.findIndex((sql) => sql.startsWith("CREATE SCHEMA"));
      expect(advisory).toBeGreaterThanOrEqual(0);
      expect(timeout).toBeGreaterThan(advisory);
      expect(timeout).toBeLessThan(firstDdl);
    });

    it("does not leak the session settings: a connection whose RESET fails is destroyed, not returned to the pool", async () => {
      const { client } = fakeClient({ column: true, index: "missing" }, [
        { match: (sql) => sql === "RESET statement_timeout", error: new Error("connection lost") },
      ]);
      const injected = injectedPool({ connect: vi.fn().mockResolvedValue(client), query: client.query });
      await createPostgresPool({ pool: injected, schema: "leak_test" }).ready();
      expect(client.release).toHaveBeenLastCalledWith(
        expect.objectContaining({ message: "connection lost" }),
      );
    });
  });

  describe("migrate: false", () => {
    it("does not check out a connection or run DDL from the pool handle", async () => {
      const connect = vi.fn();
      const handle = createPostgresPool({ pool: injectedPool({ connect }), migrate: false });
      await expect(handle.ready()).resolves.toBeUndefined();
      expect(connect).not.toHaveBeenCalled();
    });

    function poolWithCatalog(catalog: { has_table: boolean; has_column: boolean }) {
      const query = vi.fn(async () => ({ rows: [catalog], rowCount: 1 }));
      return { query } as unknown as Pool;
    }

    it("assertLineageSchemaCurrent fails fast, naming the missing DDL and the README section", async () => {
      const pool = poolWithCatalog({ has_table: true, has_column: false });
      const failure = assertLineageSchemaCurrent(pool, "prod");
      await expect(failure).rejects.toThrow(/"prod"\."kohaku_lineage" has no correlation_id column/);
      await expect(failure).rejects.toThrow(
        /ALTER TABLE "prod"\."kohaku_lineage" ADD COLUMN IF NOT EXISTS correlation_id text NULL/,
      );
      await expect(failure).rejects.toThrow(/Upgrading to 0\.4\.x/);
    });

    it("assertLineageSchemaCurrent passes when the column exists, and when there is no lineage table at all", async () => {
      await expect(
        assertLineageSchemaCurrent(poolWithCatalog({ has_table: true, has_column: true }), "prod"),
      ).resolves.toBeUndefined();
      await expect(
        assertLineageSchemaCurrent(poolWithCatalog({ has_table: false, has_column: false }), "prod"),
      ).resolves.toBeUndefined();
    });
  });
});

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createPostgresPool } from "../src/connection.js";

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

describe("createPostgresPool: ready() migration transaction", () => {
  it("does not cache a rejected migration -- the next call reconnects and retries from scratch", async () => {
    let failFirstBegin = true;
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" && failFirstBegin) {
          failFirstBegin = false;
          throw new Error("transient migration failure");
        }
        // First-stamp path's assertLineageIdIsUnique check (connection.ts): this fake pool has no real
        // pg_index to query, so answer as if kohaku_lineage already has its UNIQUE (id) -- this test is
        // about the migration retry, not that check (which has its own real-backend test in
        // schema-version.test.ts).
        if (typeof sql === "string" && sql.includes("pg_index")) return { rows: [{ ok: true }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const connect = vi.fn().mockResolvedValue(client);
    const injected = injectedPool({ connect });
    const handle = createPostgresPool({ pool: injected, schema: "retry_test" });

    await expect(handle.ready()).rejects.toThrow("transient migration failure");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);

    await expect(handle.ready()).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
  });

  it("retries once on a concurrent-DDL race (SQLSTATE 23505 / 42P07) and then succeeds", async () => {
    let raceOnce = true;
    const client = {
      query: vi.fn(async (sql: string) => {
        if (typeof sql === "string" && sql.includes("CREATE TABLE IF NOT EXISTS") && raceOnce) {
          raceOnce = false;
          const error = new Error("duplicate_object") as Error & { code: string };
          error.code = "42P07";
          throw error;
        }
        // See the sibling test above: answer the first-stamp unique-constraint check as if it passed.
        if (typeof sql === "string" && sql.includes("pg_index")) return { rows: [{ ok: true }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const connect = vi.fn().mockResolvedValue(client);
    const injected = injectedPool({ connect });
    const handle = createPostgresPool({ pool: injected, schema: "race_test" });

    await expect(handle.ready()).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(2); // the raced attempt, then the retry
  });

  it("does not check out a connection when migrate: false", async () => {
    const connect = vi.fn();
    const injected = injectedPool({ connect });
    const handle = createPostgresPool({ pool: injected, migrate: false });
    await expect(handle.ready()).resolves.toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
  });
});

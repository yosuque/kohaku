import { Pool, type PoolClient } from "pg";
import {
  DEFAULT_SCHEMA,
  POSTGRES_SCHEMA_VERSION,
  postgresSchemaSql,
  qualifiedTable,
  quoteIdentifier,
} from "./schema.js";

/** `connectTimeoutMs`'s default: `pg`'s own default is "wait forever", which turns a network partition
 * into a hang instead of a clear, timely error. */
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

/** `statementTimeoutMs`'s default: bounds a single runaway query (a lock wait, a full-table scan
 * against an un-migrated database) instead of letting it hold a pool connection indefinitely. */
const DEFAULT_STATEMENT_TIMEOUT_MS = 10000;

/** SQLSTATEs a concurrent-DDL race can surface even while holding the advisory lock (e.g. a second
 * process's transaction started, and validated the catalog, just before the first process committed
 * its own DDL) -- see `migrateSchema`'s retry-once. */
const RETRYABLE_DDL_SQLSTATES = new Set(["23505", "42P07"]);

export interface CreatePostgresPoolOptions {
  /** A `pg` connection string. Mutually exclusive with `pool`. */
  connectionString?: string;
  /**
   * An existing `pg.Pool` to share. `close()` then does not end it (the caller owns its lifecycle), and
   * no `error` listener is attached to it -- attach your own (an unhandled `error` on a `Pool` crashes
   * the process by design; see node-postgres's docs).
   */
  pool?: Pool;
  /** Schema the tables live in. Default "public". Created with `CREATE SCHEMA IF NOT EXISTS` when migrating. */
  schema?: string;
  /** Run the idempotent DDL once before the first query. Default true. Set false when migrations are managed elsewhere. */
  migrate?: boolean;
  /** Connection-establishment timeout in milliseconds for an owned pool. Default 5000. Ignored for an injected `pool`. */
  connectTimeoutMs?: number;
  /** Per-statement timeout in milliseconds, applied server-side to every connection an owned pool opens. Default 10000. Ignored for an injected `pool`. */
  statementTimeoutMs?: number;
  /** `pg.Pool`'s `max` (maximum concurrent connections) for an owned pool. Default `pg`'s own default. Ignored for an injected `pool`. */
  maxConnections?: number;
  /**
   * Called when an owned pool's idle client emits an `error` event (a backend-terminated connection,
   * a network drop) -- `pg.Pool` documents this as required listening; an unhandled one is a process
   * crash. Defaults to logging via `console.error`. Never invoked for an injected `pool` (attach your
   * own listener to it instead).
   */
  onError?: (error: Error) => void;
}

/**
 * The `Pool` lifecycle shared by `createPostgresStoragePort` and `createPostgresRevocationStore`: option
 * validation, pool construction (timeouts, `max`, the `error` listener) for an owned pool, and the
 * memoised, advisory-lock-guarded `ready()` migration with schema-version enforcement. Both adapters
 * build their own table-specific queries against `.pool` and delegate `ready()` / `close()` to this.
 */
export interface PostgresPoolHandle {
  /** The pool to issue queries against (owned or injected). */
  pool: Pool;
  /** Whether this handle created `pool` itself (as opposed to reusing an injected one). */
  owned: boolean;
  /** Resolves once the schema is in place (immediately when `migrate: false`). Memoised; a failed
   * migration is not cached, so the next call retries from scratch. */
  ready(): Promise<void>;
  /** Ends `pool` if (and only if) this handle created it. */
  close(): Promise<void>;
}

export function createPostgresPool(options: CreatePostgresPoolOptions): PostgresPoolHandle {
  if (options.pool != null && options.connectionString != null) {
    throw new Error("createPostgresPool: pass either `connectionString` or `pool`, not both");
  }
  if (options.pool == null && options.connectionString == null) {
    throw new Error("createPostgresPool: one of `connectionString` or `pool` is required");
  }

  const owned = options.pool == null;
  const schema = options.schema ?? DEFAULT_SCHEMA;

  let pool: Pool;
  if (options.pool != null) {
    pool = options.pool;
  } else {
    pool = new Pool({
      connectionString: options.connectionString,
      connectionTimeoutMillis: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      // A `ClientConfig` field (inherited by `PoolConfig`): `pg` sends it as a startup parameter, so
      // Postgres enforces it server-side on every connection this pool opens -- no per-query wiring.
      statement_timeout: options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
      ...(options.maxConnections != null ? { max: options.maxConnections } : {}),
    });
    pool.on("error", (error: Error) => {
      if (options.onError != null) {
        options.onError(error);
      } else {
        console.error("[@kohaku-ui/storage-postgres] Postgres pool error (idle client):", error);
      }
    });
  }

  let readyPromise: Promise<void> | undefined;
  const ready = (): Promise<void> => {
    if (readyPromise == null) {
      readyPromise =
        options.migrate === false
          ? Promise.resolve()
          : migrateSchema(pool, schema).catch((error: unknown) => {
              // Don't memoize a failed migration: a transient error (a network blip, a lock-wait
              // timeout) would otherwise permanently strand this handle with no retry path. Clear the
              // memo so the next `ready()` call retries the migration from scratch.
              readyPromise = undefined;
              throw error;
            });
    }
    return readyPromise;
  };

  return {
    pool,
    owned,
    ready,
    async close() {
      if (owned) await pool.end();
    },
  };
}

/**
 * Runs the idempotent DDL inside one transaction, serialized against every other migrator (this
 * process's other callers, and other processes/instances) via a session-scoped advisory lock keyed by
 * `schema` -- `CREATE TABLE IF NOT EXISTS` alone is not safe under concurrent first-run migration
 * (two instances can both pass the "does it exist" check before either commits, and race on the same
 * DDL). Also enforces `kohaku_schema_meta`: inserts `POSTGRES_SCHEMA_VERSION` on an empty table, throws
 * if a deployed schema already carries a different version.
 */
async function migrateSchema(pool: Pool, schema: string): Promise<void> {
  try {
    await runMigration(pool, schema);
  } catch (error) {
    if (!isRetryableDdlRace(error)) throw error;
    // A concurrent-DDL race can still surface here even under the advisory lock (e.g. a transaction
    // that read the catalog just before a concurrent migrator committed) -- retry once rather than
    // failing the whole process's first `ready()` on a one-off race.
    await runMigration(pool, schema);
  }
}

function isRetryableDdlRace(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && RETRYABLE_DDL_SQLSTATES.has(code);
}

async function runMigration(pool: Pool, schema: string): Promise<void> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    // Transaction-scoped advisory lock: needs the one connection this whole migration runs on (it is
    // released automatically at COMMIT/ROLLBACK). `hashtext` folds the lock name to a single int4,
    // implicitly widened to the bigint `pg_advisory_xact_lock(bigint)` overload expects.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kohaku:schema:${schema}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
    await client.query(postgresSchemaSql(schema));
    await ensureSchemaVersion(client, schema);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function ensureSchemaVersion(client: PoolClient, schema: string): Promise<void> {
  const table = qualifiedTable(schema, "kohaku_schema_meta");
  const { rows } = await client.query<{ version: number }>(`SELECT version FROM ${table} WHERE id = 1`);
  if (rows.length === 0) {
    await client.query(`INSERT INTO ${table} (id, version) VALUES (1, $1)`, [POSTGRES_SCHEMA_VERSION]);
    return;
  }
  const found = rows[0]?.version;
  if (found !== POSTGRES_SCHEMA_VERSION) {
    throw new Error(
      `@kohaku-ui/storage-postgres: schema "${schema}" is at kohaku_schema_meta.version ${found}, ` +
        `but this package expects version ${POSTGRES_SCHEMA_VERSION}. See this package's README, ` +
        `"Migrating from a pre-release schema", before upgrading a deployed database.`,
    );
  }
}

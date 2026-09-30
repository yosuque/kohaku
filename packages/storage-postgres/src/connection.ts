import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import {
  DEFAULT_SCHEMA,
  lineageCorrelationDdl,
  POSTGRES_SCHEMA_VERSION,
  postgresBaseSchemaSql,
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

/** `lock_timeout` for the migration transaction: a `ready()` that cannot get a table lock quickly (a
 * long-running lineage query holds a conflicting one) fails fast instead of queueing behind it -- a
 * queued ACCESS EXCLUSIVE / SHARE request blocks every later reader and writer of the table. */
const MIGRATION_LOCK_TIMEOUT_MS = 5000;

/** First wait after a failed `ready()` before the migration is attempted again; doubles per consecutive failure. */
const READY_RETRY_INITIAL_DELAY_MS = 1000;

/** Ceiling of the `ready()` retry backoff. */
const READY_RETRY_MAX_DELAY_MS = 60000;

/** How often a migrator waiting for another one re-tries the migration lock. */
const MIGRATION_LOCK_POLL_MS = 250;

/** What `pg.Pool` and `pg.PoolClient` share and the catalog helpers below need. */
interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

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
  /**
   * Run the idempotent DDL once before the first query. Default true. Set false when migrations are
   * managed elsewhere; `createPostgresStoragePort` then still checks, read-only, that `kohaku_lineage`
   * has the `correlation_id` column and fails fast (naming the DDL) when it does not -- see the README's
   * "Upgrading to 0.4.x".
   */
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
  /** Resolves once the schema is in place (immediately when `migrate: false`). Memoised. A failed
   * migration is not cached, but retries back off (1 s doubling to 60 s): a call inside the backoff
   * window rejects with the last error without touching the database. */
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
  let failure: { error: unknown; delayMs: number; retryAt: number } | undefined;
  const ready = (): Promise<void> => {
    if (readyPromise != null) return readyPromise;
    if (options.migrate === false) {
      readyPromise = Promise.resolve();
      return readyPromise;
    }
    // Inside the backoff window: hand back the last error instead of re-running a migration that just
    // failed -- every StoragePort method awaits `ready()`, so without this a persistent failure (a
    // slow index build, a lock held by live traffic) would re-run the DDL on every request.
    if (failure != null && Date.now() < failure.retryAt) return Promise.reject(failure.error);
    readyPromise = migrateSchema(pool, schema).then(
      () => {
        failure = undefined;
      },
      (error: unknown) => {
        // Don't memoize a failed migration: a transient error (a network blip, a lock-wait timeout)
        // would otherwise permanently strand this handle with no retry path. Clear the memo so a later
        // `ready()` call retries the migration from scratch, once the backoff has elapsed.
        readyPromise = undefined;
        const delayMs =
          failure == null
            ? READY_RETRY_INITIAL_DELAY_MS
            : Math.min(failure.delayMs * 2, READY_RETRY_MAX_DELAY_MS);
        failure = { error, delayMs, retryAt: Date.now() + delayMs };
        throw error;
      },
    );
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
 * The whole `ready()` sequence -- the idempotent DDL transaction, then the correlation index build -- on
 * one dedicated connection, serialized against every other migrator (this process's other callers, and
 * other processes/instances) by a session-level advisory lock keyed by `schema`. `CREATE TABLE IF NOT
 * EXISTS` alone is not safe under concurrent first-run migration (two instances can both pass the "does
 * it exist" check before either commits, and race on the same DDL).
 *
 * One lock covers both steps on purpose. The index build (`CREATE INDEX CONCURRENTLY`) waits for every
 * older transaction to finish, and a second migrator's transaction that is itself waiting for a table lock
 * behind that build would never finish: a deadlock. Holding the lock across the transaction and the build,
 * and acquiring it by polling outside any transaction (`acquireSessionLock`), means a waiting migrator has
 * no open transaction or running statement for the build to wait on.
 *
 * Also enforces `kohaku_schema_meta`: inserts `POSTGRES_SCHEMA_VERSION` on an empty table, throws if a
 * deployed schema already carries a different version.
 */
async function migrateSchema(pool: Pool, schema: string): Promise<void> {
  const lockKey = `kohaku:schema:${schema}`;
  const client: PoolClient = await pool.connect();
  let discard: Error | undefined;
  const remember = (error: unknown): void => {
    discard = error instanceof Error ? error : new Error(String(error));
  };
  try {
    await acquireSessionLock(client, lockKey);
    try {
      try {
        await runMigration(client, schema);
      } catch (error) {
        if (!isRetryableDdlRace(error)) throw error;
        // A concurrent-DDL race can still surface here even under the advisory lock (e.g. a transaction
        // that read the catalog just before a concurrent migrator committed) -- retry once rather than
        // failing the whole process's first `ready()` on a one-off race.
        await runMigration(client, schema);
      }
      await ensureCorrelationIndex(client, schema);
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(remember);
    }
  } finally {
    // The session setting must not leak into the pool: restore the timeout, or drop the connection.
    await client.query("RESET statement_timeout").catch(remember);
    client.release(discard);
  }
}

function isRetryableDdlRace(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && RETRYABLE_DDL_SQLSTATES.has(code);
}

async function runMigration(client: PoolClient, schema: string): Promise<void> {
  try {
    await client.query("BEGIN");
    // Waiting for another migrator happens before this transaction (`acquireSessionLock`); the timeout
    // below is for table locks behind live traffic, which must not queue. `SET LOCAL` reverts at
    // COMMIT/ROLLBACK, so it never leaks into the pool.
    await client.query(`SET LOCAL lock_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
    await client.query(postgresBaseSchemaSql(schema));
    await migrateLineageCorrelationColumn(client, schema);
    await ensureSchemaVersion(client, schema);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/**
 * Adds `kohaku_lineage.correlation_id` only when the catalog says it is missing (see `lineageCorrelationDdl`
 * for why the `IF NOT EXISTS` form alone is not enough): on an up-to-date database a start takes no lock
 * on the lineage table beyond what the base script's own `CREATE INDEX IF NOT EXISTS` statements need.
 * The column's index is not created here: it is built after this transaction commits.
 */
async function migrateLineageCorrelationColumn(client: PoolClient, schema: string): Promise<void> {
  const { hasColumn } = await lineageCorrelationCatalog(client, schema);
  if (!hasColumn) await client.query(lineageCorrelationDdl(schema).addColumnSql);
}

/** Whether `kohaku_lineage` exists in `schema` and, if so, whether it already has `correlation_id`. */
async function lineageCorrelationCatalog(
  db: Queryable,
  schema: string,
): Promise<{ hasTable: boolean; hasColumn: boolean }> {
  const { rows } = await db.query<{ has_table: boolean; has_column: boolean }>(
    `SELECT rel.oid IS NOT NULL AS has_table,
            EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = rel.oid AND a.attname = $2 AND a.attnum > 0 AND NOT a.attisdropped) AS has_column
       FROM (SELECT to_regclass($1) AS oid) rel`,
    [qualifiedTable(schema, "kohaku_lineage"), lineageCorrelationDdl(schema).columnName],
  );
  return { hasTable: rows[0]?.has_table === true, hasColumn: rows[0]?.has_column === true };
}

/**
 * The `migrate: false` counterpart of the migration: a read-only check that `kohaku_lineage` carries the
 * `correlation_id` column, because `appendLineage` writes it on every call. Without it every INSERT fails
 * with 42703, and since lineage recording is fail-open the audit events would be lost silently. A schema
 * with no `kohaku_lineage` table at all passes (a deployment that never uses lineage; the first query
 * against the missing table fails on its own).
 */
export async function assertLineageSchemaCurrent(pool: Queryable, schema: string): Promise<void> {
  const { hasTable, hasColumn } = await lineageCorrelationCatalog(pool, schema);
  if (!hasTable || hasColumn) return;
  const ddl = lineageCorrelationDdl(schema);
  throw new Error(
    `@kohaku-ui/storage-postgres: ${qualifiedTable(schema, "kohaku_lineage")} has no ${ddl.columnName} column ` +
      `(added in 0.4.0), so every appendLineage would fail and lineage events would be lost. With ` +
      `migrate: false the schema is yours to upgrade: run \`${ddl.addColumnSql}\` (and optionally ` +
      `\`${ddl.createIndexConcurrentlySql}\`) before deploying this version. See this package's README, ` +
      `"Upgrading to 0.4.x".`,
  );
}

/** `valid`, `invalid` (a failed `CREATE INDEX CONCURRENTLY` leaves one behind) or `missing`. */
async function correlationIndexState(
  db: Queryable,
  schema: string,
  indexName: string,
): Promise<"valid" | "invalid" | "missing"> {
  // Resolved through the catalog by name (`to_regclass`) rather than matching `pg_indexes.indexname`:
  // that matches an INVALID index as present, and PostgreSQL truncates a long identifier so the name
  // written in the DDL text would not equal the stored one.
  const { rows } = await db.query<{ indisvalid: boolean }>(
    `SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)`,
    [qualifiedTable(schema, indexName)],
  );
  if (rows.length === 0) return "missing";
  return rows[0]?.indisvalid === true ? "valid" : "invalid";
}

/**
 * Takes a session-level advisory lock by polling `pg_try_advisory_lock`. A blocking `pg_advisory_lock`
 * would leave the waiter inside a running statement while the holder's `CREATE INDEX CONCURRENTLY` waits
 * for every older transaction to finish: a deadlock. Each try is a statement of its own.
 */
async function acquireSessionLock(client: Queryable, key: string): Promise<void> {
  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [key],
    );
    if (rows[0]?.locked === true) return;
    await new Promise((resolve) => setTimeout(resolve, MIGRATION_LOCK_POLL_MS));
  }
}

/**
 * Makes sure the `(correlation_id, seq)` index exists and is valid, outside any transaction (`CREATE
 * INDEX CONCURRENTLY` cannot run in one, and unlike a plain `CREATE INDEX` it does not block inserts
 * while it builds). Runs with `statement_timeout = 0` (restored by the caller): the owned pool's default
 * (10 s) is far shorter than a build over a large lineage table, and a timed-out build would be rolled
 * back and restarted forever. The caller holds the migration lock. An INVALID index left by an earlier
 * failed build is dropped and rebuilt. Up to date: one catalog read, no DDL.
 */
async function ensureCorrelationIndex(client: PoolClient, schema: string): Promise<void> {
  const ddl = lineageCorrelationDdl(schema);
  const state = await correlationIndexState(client, schema, ddl.indexName);
  if (state === "valid") return;
  await client.query("SET statement_timeout = 0");
  if (state === "invalid") await client.query(ddl.dropIndexConcurrentlySql);
  await client.query(ddl.createIndexConcurrentlySql);
}

async function ensureSchemaVersion(client: PoolClient, schema: string): Promise<void> {
  const table = qualifiedTable(schema, "kohaku_schema_meta");
  const { rows } = await client.query<{ version: number }>(`SELECT version FROM ${table} WHERE id = 1`);
  if (rows.length === 0) {
    // Stamping a schema as version 1 for the first time: this is exactly the case where an existing,
    // pre-versioning deployment (see README's "Migrating from a pre-release schema") gets a free pass
    // with no row to compare against. `CREATE TABLE IF NOT EXISTS` (run just before this, in the same
    // transaction) does not retrofit `UNIQUE (id)` onto an already-existing `kohaku_lineage` table, and
    // without it the first `appendLineage`'s `ON CONFLICT (id) DO NOTHING` fails at runtime with "no
    // unique or exclusion constraint matching the ON CONFLICT specification" -- so check for it here,
    // once, while stamping, rather than let that surface later as an opaque runtime error.
    await assertLineageIdIsUnique(client, schema);
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

/**
 * Verifies a unique index/constraint on exactly `kohaku_lineage.id` exists (a fresh install's own
 * `CREATE TABLE` already declares `UNIQUE (id)`, so this is a no-op there; it only ever fires for a
 * pre-existing table that predates this package's schema-versioning support and skipped the README's
 * migration step). Checks `pg_index` directly rather than `information_schema` so a plain unique index
 * (not only a named `UNIQUE` table constraint) also satisfies it, matching what `ON CONFLICT (id)` needs.
 */
async function assertLineageIdIsUnique(client: PoolClient, schema: string): Promise<void> {
  const { rows } = await client.query<{ ok: boolean }>(
    `SELECT true AS ok
       FROM pg_index i
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
      WHERE n.nspname = $1
        AND t.relname = 'kohaku_lineage'
        AND i.indisunique
        AND i.indnatts = 1
        AND a.attname = 'id'
      LIMIT 1`,
    [schema],
  );
  if (rows.length === 0) {
    throw new Error(
      `@kohaku-ui/storage-postgres: schema "${schema}" has a kohaku_lineage table with no unique ` +
        `constraint/index on "id". This package's appendLineage relies on ON CONFLICT (id) DO NOTHING, ` +
        `which requires one. See this package's README, "Migrating from a pre-release schema", step 2 ` +
        `(ALTER TABLE kohaku_lineage ADD CONSTRAINT kohaku_lineage_id_key UNIQUE (id)), before the first ` +
        `appendLineage call.`,
    );
  }
}

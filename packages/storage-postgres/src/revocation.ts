import type { CapabilityRevocationStore } from "@kohaku-ui/spec-core";
import { Pool } from "pg";
import { DEFAULT_SCHEMA, postgresSchemaSql, qualifiedTable, quoteIdentifier } from "./schema.js";

export interface PostgresRevocationStoreOptions {
  /** A `pg` connection string. Mutually exclusive with `pool`. */
  connectionString?: string;
  /** An existing `pg.Pool` to share. `close()` then does not end it (the owner does). */
  pool?: Pool;
  /** Schema the table lives in. Default "public". Created with `CREATE SCHEMA IF NOT EXISTS` when migrating. */
  schema?: string;
  /**
   * Run the idempotent DDL once before the first query. Default true. Set false when migrations are
   * managed elsewhere. Shares `postgresSchemaSql` with `createPostgresStoragePort`, so a store used
   * alongside that port migrates the same schema (harmless: `CREATE TABLE IF NOT EXISTS`).
   */
  migrate?: boolean;
}

export interface PostgresRevocationStore extends CapabilityRevocationStore {
  /** Resolves once the schema is in place (immediately when `migrate: false`). */
  ready(): Promise<void>;
  /** Deletes expired revocation rows (an `isRevoked` already treats them as not-revoked); returns the row count. For a cron. */
  sweepExpiredRevocations(): Promise<number>;
  /** Ends the pool this store created (a no-op for an injected pool). */
  close(): Promise<void>;
}

/**
 * A PostgreSQL-backed CapabilityRevocationStore (reference adapter; spec-core's
 * `CapabilityRevocationStore`). One row per revoked `jti`, keyed by `jti` itself, with its own
 * `expires_at`; unlike `storage-redis`'s TTL-keyed entry, an expired row is not dropped automatically --
 * `isRevoked` filters it out on read (`expires_at > now()`), and `sweepExpiredRevocations()` (meant for a
 * cron, same treatment as `PostgresStoragePort.sweepExpiredSpecCache()`) deletes it.
 */
export function createPostgresRevocationStore(
  options: PostgresRevocationStoreOptions,
): PostgresRevocationStore {
  if (options.pool != null && options.connectionString != null) {
    throw new Error("createPostgresRevocationStore: pass either `connectionString` or `pool`, not both");
  }
  if (options.pool == null && options.connectionString == null) {
    throw new Error("createPostgresRevocationStore: one of `connectionString` or `pool` is required");
  }
  const owned = options.pool == null;
  const pool = options.pool ?? new Pool({ connectionString: options.connectionString });
  const schema = options.schema ?? DEFAULT_SCHEMA;
  const T = qualifiedTable(schema, "kohaku_capability_revocation");

  let readyPromise: Promise<void> | undefined;
  const ready = (): Promise<void> => {
    if (readyPromise == null) {
      readyPromise =
        options.migrate === false
          ? Promise.resolve()
          : (async () => {
              await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
              await pool.query(postgresSchemaSql(schema));
            })().catch((error: unknown) => {
              // Don't memoize a failed migration -- see `PostgresStoragePort.ready()`'s doc comment
              // (same rationale, applied here to keep this store's own retry path independent).
              readyPromise = undefined;
              throw error;
            });
    }
    return readyPromise;
  };

  return {
    ready,
    async revoke(jti, expiresAt) {
      await ready();
      await pool.query(
        `INSERT INTO ${T} (jti, expires_at) VALUES ($1, to_timestamp($2))
         ON CONFLICT (jti) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
        [jti, expiresAt],
      );
    },
    async isRevoked(jti) {
      await ready();
      const { rows } = await pool.query(`SELECT 1 FROM ${T} WHERE jti = $1 AND expires_at > now()`, [jti]);
      return rows.length > 0;
    },
    async sweepExpiredRevocations() {
      await ready();
      const result = await pool.query(`DELETE FROM ${T} WHERE expires_at <= now()`);
      return result.rowCount ?? 0;
    },
    async close() {
      if (owned) await pool.end();
    },
  };
}

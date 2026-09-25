import type { CapabilityRevocationStore } from "@kohaku-ui/spec-core";
import { type CreatePostgresPoolOptions, createPostgresPool } from "./connection.js";
import { DEFAULT_SCHEMA, qualifiedTable } from "./schema.js";

export type PostgresRevocationStoreOptions = CreatePostgresPoolOptions;

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
 * cron, same treatment as `PostgresStoragePort.sweepExpiredSpecCache()`) deletes it. Connection lifecycle
 * (timeouts, the pool `error` listener, the versioned migration) is shared with
 * `createPostgresStoragePort` via `./connection.js`.
 */
export function createPostgresRevocationStore(
  options: PostgresRevocationStoreOptions,
): PostgresRevocationStore {
  const { pool, ready, close } = createPostgresPool(options);
  const schema = options.schema ?? DEFAULT_SCHEMA;
  const table = qualifiedTable(schema, "kohaku_capability_revocation");

  return {
    ready,
    async revoke(jti, expiresAt) {
      await ready();
      await pool.query(
        `INSERT INTO ${table} (jti, expires_at) VALUES ($1, to_timestamp($2))
         ON CONFLICT (jti) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
        [jti, expiresAt],
      );
    },
    async isRevoked(jti) {
      await ready();
      const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE jti = $1 AND expires_at > now()`, [
        jti,
      ]);
      return rows.length > 0;
    },
    async sweepExpiredRevocations() {
      await ready();
      const result = await pool.query(`DELETE FROM ${table} WHERE expires_at <= now()`);
      return result.rowCount ?? 0;
    },
    close,
  };
}

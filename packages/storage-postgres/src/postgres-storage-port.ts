import type {
  FixationRecord,
  LineageEventRecord,
  PromotionState,
  StoragePort,
  UISpec,
} from "@kohaku-ui/spec-core";
import { Pool } from "pg";
import { DEFAULT_SCHEMA, postgresSchemaSql, qualifiedTable, quoteIdentifier } from "./schema.js";

export interface PostgresStoragePortOptions {
  /** A `pg` connection string. Mutually exclusive with `pool`. */
  connectionString?: string;
  /** An existing `pg.Pool` to share. `close()` then does not end it (the owner does). */
  pool?: Pool;
  /** Schema the four tables live in. Default "public". Created with `CREATE SCHEMA IF NOT EXISTS` when migrating. */
  schema?: string;
  /** Run the idempotent DDL once before the first query. Default true. Set false when migrations are managed elsewhere. */
  migrate?: boolean;
}

export interface PostgresStoragePort extends StoragePort {
  /** Resolves once the schema is in place (immediately when `migrate: false`). */
  ready(): Promise<void>;
  /** Deletes expired Spec-cache rows (a `get` already treats them as misses); returns the row count. For a cron. */
  sweepExpiredSpecCache(): Promise<number>;
  /** Ends the pool this port created (a no-op for an injected pool). */
  close(): Promise<void>;
}

/**
 * A PostgreSQL-backed StoragePort (reference adapter). One table per record kind; (tenant, id) primary keys
 * with '' as the tenant-neutral tenant; `seq` bigserial columns give the append / first-insertion order the
 * reference file port exposes. Single statements (or one transaction for the batch write) — the cross-process
 * concurrency contract of ports.ts is unchanged: the host serializes its own read-modify-write.
 */
export function createPostgresStoragePort(options: PostgresStoragePortOptions): PostgresStoragePort {
  if (options.pool != null && options.connectionString != null) {
    throw new Error("createPostgresStoragePort: pass either `connectionString` or `pool`, not both");
  }
  if (options.pool == null && options.connectionString == null) {
    throw new Error("createPostgresStoragePort: one of `connectionString` or `pool` is required");
  }
  const owned = options.pool == null;
  const pool = options.pool ?? new Pool({ connectionString: options.connectionString });
  const schema = options.schema ?? DEFAULT_SCHEMA;
  const T = {
    spec: qualifiedTable(schema, "kohaku_spec_cache"),
    lineage: qualifiedTable(schema, "kohaku_lineage"),
    promotion: qualifiedTable(schema, "kohaku_promotion_state"),
    fixation: qualifiedTable(schema, "kohaku_fixation"),
  };

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
              // Don't memoize a failed migration: a transient error (a network blip, a concurrent-DDL
              // race between two instances migrating a fresh database) would otherwise permanently
              // strand this port instance with no retry path. Clear the memo so the next `ready()`
              // call retries the migration from scratch.
              readyPromise = undefined;
              throw error;
            });
    }
    return readyPromise;
  };

  return {
    ready,
    async getSpecCache(key) {
      await ready();
      const { rows } = await pool.query<{ spec: UISpec }>(
        `SELECT spec FROM ${T.spec} WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())`,
        [key],
      );
      return rows[0]?.spec ?? null;
    },
    async putSpecCache(key, spec, ttlSeconds) {
      await ready();
      await pool.query(
        `INSERT INTO ${T.spec} (key, spec, expires_at)
         VALUES ($1, $2::jsonb, CASE WHEN $3::double precision IS NULL THEN NULL ELSE now() + ($3::double precision * interval '1 second') END)
         ON CONFLICT (key) DO UPDATE SET spec = EXCLUDED.spec, expires_at = EXCLUDED.expires_at`,
        [key, JSON.stringify(spec), ttlSeconds != null && ttlSeconds > 0 ? ttlSeconds : null],
      );
    },
    async sweepExpiredSpecCache() {
      await ready();
      const result = await pool.query(
        `DELETE FROM ${T.spec} WHERE expires_at IS NOT NULL AND expires_at <= now()`,
      );
      return result.rowCount ?? 0;
    },
    async appendLineage(event) {
      await ready();
      const str = (key: string): string | null =>
        typeof event.payload[key] === "string" ? (event.payload[key] as string) : null;
      await pool.query(
        `INSERT INTO ${T.lineage} (id, ts, tenant, type, intent_hash, artifact_id, spec_hash, record)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          event.id,
          event.ts,
          event.tenant != null && event.tenant !== "" ? event.tenant : null,
          event.type,
          str("intentHash"),
          str("artifactId"),
          str("specHash"),
          JSON.stringify(event),
        ],
      );
    },
    async listLineage(filter = {}) {
      await ready();
      const limit = filter.limit ?? 200;
      if (limit <= 0) return [];
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (clause: string, value: unknown) => {
        params.push(value);
        where.push(clause.replace("?", `$${params.length}`));
      };
      if (filter.type != null) add("type = ANY(?::text[])", filter.type);
      if (filter.tenant != null) add("tenant = ?", filter.tenant);
      if (filter.intentHash != null) add("intent_hash = ?", filter.intentHash);
      if (filter.artifactId != null) add("artifact_id = ?", filter.artifactId);
      if (filter.specHash != null) add("spec_hash = ?", filter.specHash);
      if (filter.since != null) add("ts >= ?", filter.since);
      if (filter.until != null) add("ts <= ?", filter.until);
      params.push(limit);
      const sql = `SELECT record FROM ${T.lineage}${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT $${params.length}`;
      const { rows } = await pool.query<{ record: LineageEventRecord }>(sql, params);
      // Newest-first from the query; the contract returns append order, so reverse.
      return rows.map((r) => r.record).reverse();
    },
    async getPromotionState(_artifactId: string, _tenant?: string) {
      throw new Error("not implemented");
    },
    async putPromotionState(_state: PromotionState) {
      throw new Error("not implemented");
    },
    async putPromotionStates(_states: PromotionState[]) {
      throw new Error("not implemented");
    },
    async listPromotionStates(_tenant?: string) {
      throw new Error("not implemented");
    },
    async getFixation(_intentHash: string, _tenant?: string) {
      throw new Error("not implemented");
    },
    async putFixation(_record: FixationRecord, _options?: { ifPresent?: boolean }) {
      throw new Error("not implemented");
    },
    async listFixations(_tenant?: string) {
      throw new Error("not implemented");
    },
    async deleteFixation(_intentHash: string, _tenant?: string) {
      throw new Error("not implemented");
    },
    async close() {
      if (owned) await pool.end();
    },
  };
}

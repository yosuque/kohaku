import {
  type FixationRecord,
  type LineageEventRecord,
  normalizeTenant,
  type PromotionState,
  type StoragePort,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { type CreatePostgresPoolOptions, createPostgresPool } from "./connection.js";
import { DEFAULT_SCHEMA, qualifiedTable } from "./schema.js";

export type PostgresStoragePortOptions = CreatePostgresPoolOptions;

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
 * reference file port exposes. Single statements (or one unnest-batched statement for the batch write) --
 * the cross-process concurrency contract of ports.ts is unchanged: the host serializes its own
 * read-modify-write. Connection lifecycle (timeouts, the pool `error` listener, the versioned migration)
 * is shared with `createPostgresRevocationStore` via `./connection.js`.
 */
export function createPostgresStoragePort(options: PostgresStoragePortOptions): PostgresStoragePort {
  const { pool, ready, close } = createPostgresPool(options);
  const schema = options.schema ?? DEFAULT_SCHEMA;
  const tables = {
    spec: qualifiedTable(schema, "kohaku_spec_cache"),
    lineage: qualifiedTable(schema, "kohaku_lineage"),
    promotion: qualifiedTable(schema, "kohaku_promotion_state"),
    fixation: qualifiedTable(schema, "kohaku_fixation"),
  };

  return {
    ready,
    async getSpecCache(key) {
      await ready();
      // `spec` is stored as text -- see schema.ts for why -- so this is the exact JSON that was
      // written, with no jsonb key-reordering between put and get.
      const { rows } = await pool.query<{ spec: string }>(
        `SELECT spec FROM ${tables.spec} WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())`,
        [key],
      );
      return rows[0] != null ? (JSON.parse(rows[0].spec) as UISpec) : null;
    },
    async putSpecCache(key, spec, ttlSeconds) {
      await ready();
      await pool.query(
        `INSERT INTO ${tables.spec} (key, spec, expires_at)
         VALUES ($1, $2, CASE WHEN $3::double precision IS NULL THEN NULL ELSE now() + ($3::double precision * interval '1 second') END)
         ON CONFLICT (key) DO UPDATE SET spec = EXCLUDED.spec, expires_at = EXCLUDED.expires_at`,
        [key, JSON.stringify(spec), ttlSeconds != null && ttlSeconds > 0 ? ttlSeconds : null],
      );
    },
    async sweepExpiredSpecCache() {
      await ready();
      const result = await pool.query(
        `DELETE FROM ${tables.spec} WHERE expires_at IS NOT NULL AND expires_at <= now()`,
      );
      return result.rowCount ?? 0;
    },
    async appendLineage(event) {
      await ready();
      const str = (key: string): string | null =>
        typeof event.payload[key] === "string" ? (event.payload[key] as string) : null;
      // `tenant` is `''` for a tenant-neutral event -- see schema.ts's note on why every tenant column
      // in this schema uses `''` rather than NULL. `record` is stored as text -- see schema.ts.
      // `ON CONFLICT (id) DO NOTHING`: appending an event whose `id` was already recorded is a no-op
      // (the contract's idempotent-append case), not a duplicate row or a thrown unique-violation.
      await pool.query(
        `INSERT INTO ${tables.lineage} (id, ts, tenant, type, intent_hash, artifact_id, spec_hash, record)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          event.id,
          event.ts,
          normalizeTenant(event.tenant) ?? "",
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
      // `''` behaves exactly like an unspecified tenant (normalizeTenant collapses both), matching
      // every tenant column's `''`-for-tenant-neutral convention in this schema.
      const filterTenant = normalizeTenant(filter.tenant);
      if (filterTenant != null) add("tenant = ?", filterTenant);
      if (filter.intentHash != null) add("intent_hash = ?", filter.intentHash);
      if (filter.artifactId != null) add("artifact_id = ?", filter.artifactId);
      if (filter.specHash != null) add("spec_hash = ?", filter.specHash);
      if (filter.since != null) add("ts >= ?", filter.since);
      if (filter.until != null) add("ts <= ?", filter.until);
      params.push(limit);
      const sql = `SELECT record FROM ${tables.lineage}${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT $${params.length}`;
      // `record` is stored as text -- see schema.ts -- so no jsonb key-reordering between put and get.
      const { rows } = await pool.query<{ record: string }>(sql, params);
      // Newest-first from the query; the contract returns append order, so reverse.
      return rows.map((r) => JSON.parse(r.record) as LineageEventRecord).reverse();
    },
    async getPromotionState(artifactId, tenant) {
      await ready();
      // `state` is stored as text -- see schema.ts -- so no jsonb key-reordering between put and get.
      const { rows } = await pool.query<{ state: string }>(
        `SELECT state FROM ${tables.promotion} WHERE tenant = $1 AND artifact_id = $2`,
        [normalizeTenant(tenant) ?? "", artifactId],
      );
      return rows[0] != null ? (JSON.parse(rows[0].state) as PromotionState) : null;
    },
    async putPromotionState(state) {
      await ready();
      await pool.query(
        `INSERT INTO ${tables.promotion} (tenant, artifact_id, state) VALUES ($1, $2, $3)
         ON CONFLICT (tenant, artifact_id) DO UPDATE SET state = EXCLUDED.state`,
        [normalizeTenant(state.tenant) ?? "", state.artifactId, JSON.stringify(state)],
      );
    },
    async putPromotionStates(states) {
      if (states.length === 0) return;
      await ready();
      // Dedupe by (tenant, artifactId), last write wins, before the single batched statement below --
      // `unnest` feeds every row to one INSERT, so a duplicate key within the same call would otherwise
      // hit `ON CONFLICT` twice for the same target row in one statement, which Postgres rejects
      // ("ON CONFLICT DO UPDATE command cannot affect row a second time").
      const deduped = new Map<string, PromotionState>();
      for (const state of states) {
        deduped.set(`${normalizeTenant(state.tenant) ?? ""}\u0000${state.artifactId}`, state);
      }
      const tenants: string[] = [];
      const artifactIds: string[] = [];
      const payloads: string[] = [];
      for (const state of deduped.values()) {
        tenants.push(normalizeTenant(state.tenant) ?? "");
        artifactIds.push(state.artifactId);
        payloads.push(JSON.stringify(state));
      }
      await pool.query(
        `INSERT INTO ${tables.promotion} (tenant, artifact_id, state)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
         ON CONFLICT (tenant, artifact_id) DO UPDATE SET state = EXCLUDED.state`,
        [tenants, artifactIds, payloads],
      );
    },
    async listPromotionStates(tenant) {
      await ready();
      const normalized = normalizeTenant(tenant);
      const { rows } =
        normalized == null
          ? await pool.query<{ state: string }>(`SELECT state FROM ${tables.promotion} ORDER BY seq`)
          : await pool.query<{ state: string }>(
              `SELECT state FROM ${tables.promotion} WHERE tenant = $1 ORDER BY seq`,
              [normalized],
            );
      return rows.map((r) => JSON.parse(r.state) as PromotionState);
    },
    async getFixation(intentHash, tenant) {
      await ready();
      // `record` is stored as text -- see schema.ts -- so no jsonb key-reordering between put and get.
      const { rows } = await pool.query<{ record: string }>(
        `SELECT record FROM ${tables.fixation} WHERE tenant = $1 AND intent_hash = $2`,
        [normalizeTenant(tenant) ?? "", intentHash],
      );
      return rows[0] != null ? (JSON.parse(rows[0].record) as FixationRecord) : null;
    },
    async putFixation(record, options) {
      await ready();
      const params = [normalizeTenant(record.tenant) ?? "", record.intentHash, JSON.stringify(record)];
      if (options?.ifPresent === true) {
        await pool.query(
          `UPDATE ${tables.fixation} SET record = $3 WHERE tenant = $1 AND intent_hash = $2`,
          params,
        );
        return;
      }
      await pool.query(
        `INSERT INTO ${tables.fixation} (tenant, intent_hash, record) VALUES ($1, $2, $3)
         ON CONFLICT (tenant, intent_hash) DO UPDATE SET record = EXCLUDED.record`,
        params,
      );
    },
    async listFixations(tenant) {
      await ready();
      const normalized = normalizeTenant(tenant);
      const { rows } =
        normalized == null
          ? await pool.query<{ record: string }>(`SELECT record FROM ${tables.fixation} ORDER BY seq`)
          : await pool.query<{ record: string }>(
              `SELECT record FROM ${tables.fixation} WHERE tenant = $1 ORDER BY seq`,
              [normalized],
            );
      return rows.map((r) => JSON.parse(r.record) as FixationRecord);
    },
    async deleteFixation(intentHash, tenant) {
      await ready();
      await pool.query(`DELETE FROM ${tables.fixation} WHERE tenant = $1 AND intent_hash = $2`, [
        normalizeTenant(tenant) ?? "",
        intentHash,
      ]);
    },
    close,
  };
}

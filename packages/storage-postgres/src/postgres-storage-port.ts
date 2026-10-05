import {
  clampLineagePageSize,
  DEFAULT_LINEAGE_LIMIT,
  decodeSeqCursor,
  encodeSeqCursor,
  type FixationRecord,
  type LineageEventRecord,
  type LineageFilter,
  normalizeTenant,
  type PromotionState,
  type StoragePort,
  type UISpec,
} from "@kohaku-ui/spec-core";
import {
  assertLineageSchemaCurrent,
  type CreatePostgresPoolOptions,
  createPostgresPool,
} from "./connection.js";
import { correlationColumnValue, DEFAULT_SCHEMA, qualifiedTable } from "./schema.js";
import { tenantKeyedTable } from "./tenant-keyed-table.js";

export type PostgresStoragePortOptions = CreatePostgresPoolOptions;

export interface PostgresStoragePort extends StoragePort {
  /** Resolves once the schema is in place (immediately when `migrate: false`). */
  ready(): Promise<void>;
  /** Deletes expired Spec-cache rows (a `get` already treats them as misses); returns the row count. For a cron. */
  sweepExpiredSpecCache(): Promise<number>;
  /** Ends the pool this port created (a no-op for an injected pool). */
  close(): Promise<void>;
}

function correlationForColumn(correlationId: string | null): string | null {
  return correlationId == null ? null : correlationColumnValue(correlationId);
}

/**
 * The WHERE predicates (and their `$n` parameters) shared by `listLineage` and `pageLineage`, in a fixed
 * order: the optional `seq > afterSeq` first, then type / tenant / intentHash / artifactId / specHash /
 * correlationId / since / until. The caller appends its own trailing parameter (LIMIT).
 */
function lineageWhere(
  filter: Omit<LineageFilter, "limit">,
  options: { afterSeq?: number } = {},
): { where: string[]; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace("?", `$${params.length}`));
  };
  if (options.afterSeq !== undefined) add("seq > ?", options.afterSeq);
  if (filter.type != null) add("type = ANY(?::text[])", filter.type);
  // `''` behaves exactly like an unspecified tenant (normalizeTenant collapses both), matching
  // every tenant column's `''`-for-tenant-neutral convention in this schema.
  const filterTenant = normalizeTenant(filter.tenant);
  if (filterTenant != null) add("tenant = ?", filterTenant);
  if (filter.intentHash != null) add("intent_hash = ?", filter.intentHash);
  if (filter.artifactId != null) add("artifact_id = ?", filter.artifactId);
  if (filter.specHash != null) add("spec_hash = ?", filter.specHash);
  if (filter.correlationId != null) add("correlation_id = ?", correlationColumnValue(filter.correlationId));
  if (filter.since != null) add("ts >= ?", filter.since);
  if (filter.until != null) add("ts <= ?", filter.until);
  return { where, params };
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
  const { pool, ready: poolReady, close } = createPostgresPool(options);
  const schema = options.schema ?? DEFAULT_SCHEMA;
  // `migrate: false` leaves the schema to the operator, so verify (read-only) that it has what
  // `appendLineage` writes instead of losing audit events to 42703. A pass is remembered; a failure is not,
  // so an operator can apply the DDL and the next call succeeds without a restart.
  let schemaVerified = options.migrate !== false;
  const ready = async (): Promise<void> => {
    await poolReady();
    if (schemaVerified) return;
    await assertLineageSchemaCurrent(pool, schema);
    schemaVerified = true;
  };
  const tables = {
    spec: qualifiedTable(schema, "kohaku_spec_cache"),
    lineage: qualifiedTable(schema, "kohaku_lineage"),
    promotion: qualifiedTable(schema, "kohaku_promotion_state"),
    fixation: qualifiedTable(schema, "kohaku_fixation"),
  };
  const promotionStates = tenantKeyedTable<PromotionState>(pool, tables.promotion, "artifact_id", "state");
  const fixations = tenantKeyedTable<FixationRecord>(pool, tables.fixation, "intent_hash", "record");

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
        `INSERT INTO ${tables.lineage} (id, ts, tenant, type, intent_hash, artifact_id, spec_hash, correlation_id, record)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [
          event.id,
          event.ts,
          normalizeTenant(event.tenant) ?? "",
          event.type,
          str("intentHash"),
          str("artifactId"),
          str("specHash"),
          correlationForColumn(str("correlationId")),
          JSON.stringify(event),
        ],
      );
    },
    async listLineage(filter = {}) {
      await ready();
      const limit = filter.limit ?? DEFAULT_LINEAGE_LIMIT;
      if (limit <= 0) return [];
      const { where, params } = lineageWhere(filter);
      params.push(limit);
      const sql = `SELECT record FROM ${tables.lineage}${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT $${params.length}`;
      // `record` is stored as text -- see schema.ts -- so no jsonb key-reordering between put and get.
      const { rows } = await pool.query<{ record: string }>(sql, params);
      // Newest-first from the query; the contract returns append order, so reverse.
      return rows.map((r) => JSON.parse(r.record) as LineageEventRecord).reverse();
    },
    async pageLineage(req) {
      await ready();
      const pageSize = clampLineagePageSize(req.pageSize);
      // Malformed cursor throws before issuing any query (same contract as pageLineageArray / readLineagePage).
      const afterSeq = req.cursor != null ? decodeSeqCursor(req.cursor) : 0;
      const { where, params } = lineageWhere(req, { afterSeq });
      // Read one past pageSize to detect whether a further page exists, mirroring pageLineageArray /
      // readLineagePage's "peek one match ahead" strategy.
      params.push(pageSize + 1);
      const sql = `SELECT seq, record FROM ${tables.lineage} WHERE ${where.join(" AND ")} ORDER BY seq ASC LIMIT $${params.length}`;
      const { rows } = await pool.query<{ seq: string; record: string }>(sql, params);
      const hasMore = rows.length > pageSize;
      const page = hasMore ? rows.slice(0, pageSize) : rows;
      const events = page.map((r) => JSON.parse(r.record) as LineageEventRecord);
      if (!hasMore) return { events };
      // `seq` is a bigint (bigserial) -- pg returns it as a string; Number() is safe here because a
      // lineage log reaching Number.MAX_SAFE_INTEGER rows is not a realistic operating condition for
      // this reference adapter, matching the assumption every other adapter's seq already makes.
      const lastSeq = Number(page[page.length - 1]!.seq);
      return { events, nextCursor: encodeSeqCursor(lastSeq) };
    },
    async getPromotionState(artifactId, tenant) {
      await ready();
      return promotionStates.get(tenant, artifactId);
    },
    async putPromotionState(state) {
      await ready();
      await promotionStates.put(state.tenant, state.artifactId, state);
    },
    async putPromotionStates(states) {
      if (states.length === 0) return;
      await ready();
      // Deduped by (tenant, artifactId), last write wins, inside `putMany` before the single batched statement.
      await promotionStates.putMany(
        states.map((state) => ({ tenant: state.tenant, id: state.artifactId, record: state })),
      );
    },
    async listPromotionStates(tenant) {
      await ready();
      return promotionStates.list(tenant);
    },
    async getFixation(intentHash, tenant) {
      await ready();
      return fixations.get(tenant, intentHash);
    },
    async putFixation(record, options) {
      await ready();
      if (options?.ifPresent === true) {
        await fixations.updateExisting(record.tenant, record.intentHash, record);
        return;
      }
      await fixations.put(record.tenant, record.intentHash, record);
    },
    async listFixations(tenant) {
      await ready();
      return fixations.list(tenant);
    },
    async deleteFixation(intentHash, tenant) {
      await ready();
      await fixations.delete(tenant, intentHash);
    },
    close,
  };
}

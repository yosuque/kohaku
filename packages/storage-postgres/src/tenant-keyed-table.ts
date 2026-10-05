import { normalizeTenant } from "@kohaku-ui/spec-core";
import type { Pool } from "pg";

/**
 * The record-kind-agnostic read / write statements of a `(tenant, <id column>)`-keyed table whose rows hold
 * one JSON payload stored as text (see schema.ts for why it is never jsonb) and a `seq` first-insertion
 * order. The promotion-state and fixation tables share this shape, so both ports' methods are thin calls
 * into one of these. It does not call `ready()` -- the caller does, first, exactly where it always did (so a
 * batch write can still return on an empty input before touching the pool).
 */
export interface TenantKeyedTable<T> {
  /** The record for `(tenant, id)`, or `null`. An unspecified or `''` tenant is the tenant-neutral key. */
  get(tenant: string | undefined, id: string): Promise<T | null>;
  /** Upserts one record, keeping its first-insertion `seq`. */
  put(tenant: string | undefined, id: string, record: T): Promise<void>;
  /** Replaces the payload of an existing `(tenant, id)` row only; never creates one. */
  updateExisting(tenant: string | undefined, id: string, record: T): Promise<void>;
  /**
   * Upserts every record in one `unnest`-batched statement. Duplicates by `(tenant, id)` are collapsed first
   * (last write wins, at the first occurrence's position): `unnest` feeds every row to one INSERT, so a
   * duplicate key within the same call would otherwise hit `ON CONFLICT` twice for the same target row in
   * one statement, which Postgres rejects ("ON CONFLICT DO UPDATE command cannot affect row a second time").
   */
  putMany(entries: readonly { tenant: string | undefined; id: string; record: T }[]): Promise<void>;
  /** Every record in first-insertion order; an unspecified tenant lists all tenants. */
  list(tenant: string | undefined): Promise<T[]>;
  /** Deletes the `(tenant, id)` row (a no-op when absent). */
  delete(tenant: string | undefined, id: string): Promise<void>;
}

export function tenantKeyedTable<T>(
  pool: Pool,
  table: string,
  idColumn: string,
  payloadColumn: string,
): TenantKeyedTable<T> {
  return {
    async get(tenant, id) {
      // The payload is stored as text, so no jsonb key-reordering between put and get.
      const { rows } = await pool.query<Record<string, string>>(
        `SELECT ${payloadColumn} FROM ${table} WHERE tenant = $1 AND ${idColumn} = $2`,
        [normalizeTenant(tenant) ?? "", id],
      );
      const row = rows[0];
      return row != null ? (JSON.parse(row[payloadColumn] as string) as T) : null;
    },
    async put(tenant, id, record) {
      await pool.query(
        `INSERT INTO ${table} (tenant, ${idColumn}, ${payloadColumn}) VALUES ($1, $2, $3)
         ON CONFLICT (tenant, ${idColumn}) DO UPDATE SET ${payloadColumn} = EXCLUDED.${payloadColumn}`,
        [normalizeTenant(tenant) ?? "", id, JSON.stringify(record)],
      );
    },
    async updateExisting(tenant, id, record) {
      await pool.query(`UPDATE ${table} SET ${payloadColumn} = $3 WHERE tenant = $1 AND ${idColumn} = $2`, [
        normalizeTenant(tenant) ?? "",
        id,
        JSON.stringify(record),
      ]);
    },
    async putMany(entries) {
      const deduped = new Map<string, { tenant: string | undefined; id: string; record: T }>();
      for (const entry of entries) {
        deduped.set(`${normalizeTenant(entry.tenant) ?? ""}\u0000${entry.id}`, entry);
      }
      const tenants: string[] = [];
      const ids: string[] = [];
      const payloads: string[] = [];
      for (const entry of deduped.values()) {
        tenants.push(normalizeTenant(entry.tenant) ?? "");
        ids.push(entry.id);
        payloads.push(JSON.stringify(entry.record));
      }
      await pool.query(
        `INSERT INTO ${table} (tenant, ${idColumn}, ${payloadColumn})
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
         ON CONFLICT (tenant, ${idColumn}) DO UPDATE SET ${payloadColumn} = EXCLUDED.${payloadColumn}`,
        [tenants, ids, payloads],
      );
    },
    async list(tenant) {
      const normalized = normalizeTenant(tenant);
      const { rows } =
        normalized == null
          ? await pool.query<Record<string, string>>(`SELECT ${payloadColumn} FROM ${table} ORDER BY seq`)
          : await pool.query<Record<string, string>>(
              `SELECT ${payloadColumn} FROM ${table} WHERE tenant = $1 ORDER BY seq`,
              [normalized],
            );
      return rows.map((r) => JSON.parse(r[payloadColumn] as string) as T);
    },
    async delete(tenant, id) {
      await pool.query(`DELETE FROM ${table} WHERE tenant = $1 AND ${idColumn} = $2`, [
        normalizeTenant(tenant) ?? "",
        id,
      ]);
    },
  };
}

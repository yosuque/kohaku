import { normalizeTenant, StorageConflictError } from "@kohaku-ui/spec-core";
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
  /**
   * Upserts one record, keeping its first-insertion `seq`. `expectedRevision` makes it a compare-and-set
   * (omitted = the plain upsert): `null` = insert only if the row is absent, a string = update only if the
   * stored payload's `revision` equals it; a miss throws `StorageConflictError`.
   */
  put(tenant: string | undefined, id: string, record: T, expectedRevision?: string | null): Promise<void>;
  /**
   * Replaces the payload of an existing `(tenant, id)` row only; never creates one. With `expectedRevision`
   * the row must also carry exactly that `revision`: an absent row is still a silent no-op, a present row
   * with a different revision throws `StorageConflictError`.
   */
  updateExisting(tenant: string | undefined, id: string, record: T, expectedRevision?: string): Promise<void>;
  /**
   * Upserts every record in one `unnest`-batched statement. Duplicates by `(tenant, id)` are collapsed first
   * (last write wins, at the first occurrence's position): `unnest` feeds every row to one INSERT, so a
   * duplicate key within the same call would otherwise hit `ON CONFLICT` twice for the same target row in
   * one statement, which Postgres rejects ("ON CONFLICT DO UPDATE command cannot affect row a second time").
   */
  putMany(entries: readonly { tenant: string | undefined; id: string; record: T }[]): Promise<void>;
  /** Every record in first-insertion order; an unspecified tenant lists all tenants. */
  list(tenant: string | undefined): Promise<T[]>;
  /**
   * Deletes the `(tenant, id)` row (a no-op when absent). With `expectedRevision` the delete is conditional
   * on the stored payload's `revision`; zero rows deleted (absent or different revision) throws
   * `StorageConflictError`.
   */
  delete(tenant: string | undefined, id: string, expectedRevision?: string): Promise<void>;
}

/**
 * Runs one conditional statement of the compare-and-set path, mapping SQLSTATE `40001` (serialization
 * failure) to `StorageConflictError`. Under the default READ COMMITTED a conditional UPDATE / DELETE re-checks its
 * predicate and simply matches no row; under a stricter isolation level (a pool configured with
 * `default_transaction_isolation = 'repeatable read'` or `serializable`) Postgres instead aborts with 40001 when
 * the row changed concurrently, which is the same "another writer got there first" outcome and must answer
 * 409 CONFLICT, not 500.
 */
async function conditional<R>(kind: "promotion" | "fixation", id: string, run: () => Promise<R>): Promise<R> {
  try {
    return await run();
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === "40001") throw new StorageConflictError(kind, id);
    throw e;
  }
}

export function tenantKeyedTable<T>(
  pool: Pool,
  table: string,
  idColumn: string,
  payloadColumn: string,
  kind: "promotion" | "fixation",
): TenantKeyedTable<T> {
  // The payload is stored as text (see schema.ts), so the revision predicate casts it to jsonb. No DDL: the
  // compare-and-set is one conditional statement whose rowCount says whether it applied.
  const revisionOf = `(${payloadColumn}::jsonb ->> 'revision')`;
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
    async put(tenant, id, record, expectedRevision) {
      if (expectedRevision === null) {
        // Must not exist yet: a lost insert race (or an existing row) inserts nothing.
        const inserted = await conditional(kind, id, () =>
          pool.query(
            `INSERT INTO ${table} (tenant, ${idColumn}, ${payloadColumn}) VALUES ($1, $2, $3)
             ON CONFLICT (tenant, ${idColumn}) DO NOTHING`,
            [normalizeTenant(tenant) ?? "", id, JSON.stringify(record)],
          ),
        );
        if (inserted.rowCount === 0) throw new StorageConflictError(kind, id);
        return;
      }
      if (expectedRevision !== undefined) {
        const updated = await conditional(kind, id, () =>
          pool.query(
            `UPDATE ${table} SET ${payloadColumn} = $3
             WHERE tenant = $1 AND ${idColumn} = $2 AND ${revisionOf} = $4::text`,
            [normalizeTenant(tenant) ?? "", id, JSON.stringify(record), expectedRevision],
          ),
        );
        if (updated.rowCount === 0) throw new StorageConflictError(kind, id);
        return;
      }
      await pool.query(
        `INSERT INTO ${table} (tenant, ${idColumn}, ${payloadColumn}) VALUES ($1, $2, $3)
         ON CONFLICT (tenant, ${idColumn}) DO UPDATE SET ${payloadColumn} = EXCLUDED.${payloadColumn}`,
        [normalizeTenant(tenant) ?? "", id, JSON.stringify(record)],
      );
    },
    async updateExisting(tenant, id, record, expectedRevision) {
      const normalized = normalizeTenant(tenant) ?? "";
      if (expectedRevision === undefined) {
        await pool.query(`UPDATE ${table} SET ${payloadColumn} = $3 WHERE tenant = $1 AND ${idColumn} = $2`, [
          normalized,
          id,
          JSON.stringify(record),
        ]);
        return;
      }
      const updated = await conditional(kind, id, () =>
        pool.query(
          `UPDATE ${table} SET ${payloadColumn} = $3
           WHERE tenant = $1 AND ${idColumn} = $2 AND ${revisionOf} = $4::text`,
          [normalized, id, JSON.stringify(record), expectedRevision],
        ),
      );
      if (updated.rowCount !== 0) return;
      // Zero rows: either the row is absent (ifPresent's silent no-op) or it carries another revision (a
      // conflict). The existence probe is not atomic with the UPDATE, but both answers are valid for a row
      // deleted or replaced in between.
      const probe = await pool.query(`SELECT 1 FROM ${table} WHERE tenant = $1 AND ${idColumn} = $2`, [
        normalized,
        id,
      ]);
      if (probe.rowCount !== 0) throw new StorageConflictError(kind, id);
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
    async delete(tenant, id, expectedRevision) {
      if (expectedRevision !== undefined) {
        const deleted = await conditional(kind, id, () =>
          pool.query(
            `DELETE FROM ${table} WHERE tenant = $1 AND ${idColumn} = $2 AND ${revisionOf} = $3::text`,
            [normalizeTenant(tenant) ?? "", id, expectedRevision],
          ),
        );
        if (deleted.rowCount === 0) throw new StorageConflictError(kind, id);
        return;
      }
      await pool.query(`DELETE FROM ${table} WHERE tenant = $1 AND ${idColumn} = $2`, [
        normalizeTenant(tenant) ?? "",
        id,
      ]);
    },
  };
}

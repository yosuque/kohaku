import {
  DEFAULT_LINEAGE_LIMIT,
  type LineageEventRecord,
  type LineageFilter,
  matchesLineageFilter,
  normalizeTenant,
  StorageConflictError,
} from "@kohaku-ui/spec-core";

/**
 * The key convention shared by every store keyed by (tenant, id) (the multi-tenant contract).
 * An unspecified tenant (single tenant) is id itself = byte-matches the old (no-tenant) file's key, so an old file
 * loads compatibly as-is without conversion (legacy = tenant-neutral). Only when a tenant is specified:
 * `${tenant}\u0000${id}` (NUL separator; it appears in neither a tenant identifier nor an artifactId / intentHash,
 * so the composite key does not collide). An empty-string tenant is normalized to "unspecified" (normalizeTenant),
 * so it byte-matches the no-tenant key too.
 */
export function tenantKey(tenant: string | undefined, id: string): string {
  const normalized = normalizeTenant(tenant);
  return normalized != null ? `${normalized}\u0000${id}` : id;
}

/**
 * Lists a (tenant, id)-keyed map, optionally filtered to a tenant (unspecified = all, including tenant-less
 * entries). Both the filter tenant and each entry's own tenant are normalized (normalizeTenant) before
 * comparison, so an empty-string tenant on either side is treated as unspecified.
 */
export function listByTenant<T extends { tenant?: string }>(map: Map<string, T>, tenant?: string): T[] {
  const normalized = normalizeTenant(tenant);
  const values = [...map.values()];
  return normalized == null ? values : values.filter((v) => normalizeTenant(v.tenant) === normalized);
}

/**
 * Applies a LineageFilter to an append-ordered event list and returns the tail `limit` entries, oldest
 * first (spec-core's matchesLineageFilter; default DEFAULT_LINEAGE_LIMIT). Equivalent to filtering the whole
 * list and then `applyLineageLimit`, but scans from the newest event backwards and stops once `limit`
 * matches are found, so a small tail window over a long log does not evaluate the filter on every event.
 */
export function filterLineage(
  events: readonly LineageEventRecord[],
  filter: LineageFilter = {},
): LineageEventRecord[] {
  const limit = filter.limit ?? DEFAULT_LINEAGE_LIMIT;
  if (limit <= 0) return [];
  // `applyLineageLimit` is `slice(-limit)`, which truncates the limit toward zero and treats a result of 0
  // (NaN, or a fraction below 1) as "no bound"; keep that behaviour exactly.
  const truncated = Math.trunc(limit);
  const bound = truncated > 0 ? truncated : Number.POSITIVE_INFINITY;
  const newestFirst: LineageEventRecord[] = [];
  for (let i = events.length - 1; i >= 0 && newestFirst.length < bound; i--) {
    const event = events[i];
    if (event != null && matchesLineageFilter(event, filter)) newestFirst.push(event);
  }
  return newestFirst.reverse();
}

/**
 * The compare-and-set check shared by the memory and file ports (`StoragePort.supportsCompareAndSet`):
 * throws {@link StorageConflictError} unless `existing` (the stored record, `undefined` when absent) satisfies
 * the four-state `expected`. `undefined` = no check; `null` = the record must be absent; `""` = the record must
 * be present and carry no `revision` (it predates the field); any other string = the record must be present and
 * carry exactly that `revision`. Both of the last two are `(existing.revision ?? "") === expected` on a present
 * record, so a record with no revision never matches a non-empty string.
 */
export function checkExpectedRevision(
  kind: "promotion" | "fixation",
  key: string,
  existing: { revision?: string } | undefined,
  expected: string | null | undefined,
): void {
  if (expected === undefined) return;
  if (expected === null) {
    if (existing !== undefined) throw new StorageConflictError(kind, key);
    return;
  }
  if (existing === undefined || (existing.revision ?? "") !== expected) {
    throw new StorageConflictError(kind, key);
  }
}

/**
 * Decides a `putFixation` against the stored record (`existing`, `undefined` when absent): `"skip"` when
 * `ifPresent` applies to an absent record (the write is a silent no-op), `"write"` when the write may
 * proceed, and a thrown {@link StorageConflictError} when `expectedRevision` is not satisfied. `ifPresent`
 * is applied first, and `ifPresent` together with `expectedRevision: null` ("must exist" and "must not
 * exist") always conflicts.
 */
export function planFixationWrite(
  intentHash: string,
  existing: { revision?: string } | undefined,
  options: { ifPresent?: boolean; expectedRevision?: string | null } | undefined,
): "write" | "skip" {
  if (options?.ifPresent === true && options.expectedRevision === null) {
    throw new StorageConflictError("fixation", intentHash);
  }
  if (options?.ifPresent === true && existing === undefined) return "skip";
  checkExpectedRevision("fixation", intentHash, existing, options?.expectedRevision);
  return "write";
}

import {
  DEFAULT_LINEAGE_LIMIT,
  type LineageEventRecord,
  type LineageFilter,
  matchesLineageFilter,
  normalizeTenant,
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

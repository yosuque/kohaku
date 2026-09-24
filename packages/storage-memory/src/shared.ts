import type { LineageEventRecord, LineageFilter } from "@kohaku-ui/spec-core";

/**
 * The key convention shared by every store keyed by (tenant, id) (the multi-tenant contract).
 * An unspecified tenant (single tenant) is id itself = byte-matches the old (no-tenant) file's key, so an old file
 * loads compatibly as-is without conversion (legacy = tenant-neutral). Only when a tenant is specified:
 * `${tenant}\u0000${id}` (NUL separator; it appears in neither a tenant identifier nor an artifactId / intentHash,
 * so the composite key does not collide).
 */
export function tenantKey(tenant: string | undefined, id: string): string {
  return tenant != null && tenant !== "" ? `${tenant}\u0000${id}` : id;
}

/** Lists a (tenant, id)-keyed map, optionally filtered to a tenant (unspecified = all, including tenant-less entries). */
export function listByTenant<T extends { tenant?: string }>(map: Map<string, T>, tenant?: string): T[] {
  const values = [...map.values()];
  return tenant == null ? values : values.filter((v) => v.tenant === tenant);
}

/**
 * Applies a LineageFilter to an append-ordered event list and returns the tail `limit` entries (default 200).
 * limit <= 0 is an empty array (symmetric with the Python implementation; D1): closes the trap where slice(-0)
 * === slice(0) returns all, and where a negative value returns other than the tail.
 */
export function filterLineage(
  events: readonly LineageEventRecord[],
  filter: LineageFilter = {},
): LineageEventRecord[] {
  let result: readonly LineageEventRecord[] = events;
  if (filter.type != null) result = result.filter((e) => filter.type!.includes(e.type));
  if (filter.tenant != null) result = result.filter((e) => e.tenant === filter.tenant);
  if (filter.intentHash != null) result = result.filter((e) => e.payload["intentHash"] === filter.intentHash);
  if (filter.artifactId != null) result = result.filter((e) => e.payload["artifactId"] === filter.artifactId);
  if (filter.specHash != null) result = result.filter((e) => e.payload["specHash"] === filter.specHash);
  if (filter.since != null) result = result.filter((e) => e.ts >= filter.since!);
  if (filter.until != null) result = result.filter((e) => e.ts <= filter.until!);
  const limit = filter.limit ?? 200;
  if (limit <= 0) return [];
  return result.slice(-limit);
}

import type { LineageEventRecord, LineageFilter } from "./ports.js";
import { normalizeTenant } from "./ports.js";

/**
 * Default tail-window size for `StoragePort.listLineage` when the caller's `LineageFilter.limit` is
 * omitted. Shared by every StoragePort implementation and by port-contracts' shared fixtures, so the
 * number lives in one place instead of being copied into each adapter.
 */
export const DEFAULT_LINEAGE_LIMIT = 200;

/**
 * The `LineageEventRecord.payload` fields a `LineageFilter` can match by exact equality. Adapters that
 * maintain a secondary index over lineage (a DB column, a JSON index, ...) should index exactly these
 * fields, since they are the only payload fields `matchesLineageFilter` ever reads.
 */
export const LINEAGE_PAYLOAD_INDEX_FIELDS = ["intentHash", "artifactId", "specHash"] as const;

/**
 * Whether a single lineage event satisfies every condition of a `LineageFilter` (all ANDed): `type`
 * membership, `tenant` equality (after `normalizeTenant` on both sides, so an empty-string tenant on
 * either side behaves like an unspecified one), the `intentHash` / `artifactId` / `specHash` payload
 * fields by exact equality, and `since` / `until` inclusive bounds on `ts`. Does not apply `limit` (see
 * `applyLineageLimit`) — this is the per-event predicate every StoragePort's `listLineage` should share
 * instead of re-deriving it.
 */
export function matchesLineageFilter(event: LineageEventRecord, filter: LineageFilter): boolean {
  if (filter.type != null && !filter.type.includes(event.type)) return false;
  const filterTenant = normalizeTenant(filter.tenant);
  if (filterTenant != null && normalizeTenant(event.tenant) !== filterTenant) return false;
  if (filter.intentHash != null && event.payload["intentHash"] !== filter.intentHash) return false;
  if (filter.artifactId != null && event.payload["artifactId"] !== filter.artifactId) return false;
  if (filter.specHash != null && event.payload["specHash"] !== filter.specHash) return false;
  if (filter.since != null && event.ts < filter.since) return false;
  if (filter.until != null && event.ts > filter.until) return false;
  return true;
}

/**
 * The most recent `limit` items of an append-ordered list (a tail slice) — the shape `listLineage`
 * returns after filtering. `limit <= 0` is an empty array (symmetric with the Python implementation, D1):
 * this closes the trap where `slice(-0) === slice(0)` returns everything, and where a negative limit
 * would otherwise slice from the front instead of returning nothing. Defaults to `DEFAULT_LINEAGE_LIMIT`
 * when `limit` is omitted.
 */
export function applyLineageLimit<T>(items: readonly T[], limit: number = DEFAULT_LINEAGE_LIMIT): T[] {
  if (limit <= 0) return [];
  return items.slice(-limit);
}

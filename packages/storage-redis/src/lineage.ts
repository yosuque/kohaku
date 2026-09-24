import type { LineageEventRecord, LineageFilter } from "@kohaku-ui/spec-core";

/** Fields a lineage event is indexed by (each becomes one sorted set per distinct value). */
export const LINEAGE_INDEX_FIELDS = ["type", "tenant", "intentHash", "artifactId", "specHash"] as const;

const DEFAULT_LIMIT = 200;

function payloadString(event: LineageEventRecord, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === "string" ? value : undefined;
}

export function indexValues(event: LineageEventRecord): { field: string; value: string }[] {
  const out: { field: string; value: string }[] = [{ field: "type", value: event.type }];
  if (event.tenant != null && event.tenant !== "") out.push({ field: "tenant", value: event.tenant });
  for (const field of ["intentHash", "artifactId", "specHash"] as const) {
    const value = payloadString(event, field);
    if (value != null) out.push({ field, value });
  }
  return out;
}

/**
 * Picks the sorted set(s) to read candidate ids from, most selective first. `null` means "no usable
 * index — scan the by-seq set". The remaining predicates are applied client-side by `matchesFilter`.
 */
export function chooseCandidateIndex(filter: LineageFilter): { field: string; values: string[] } | null {
  if (filter.intentHash != null) return { field: "intentHash", values: [filter.intentHash] };
  if (filter.artifactId != null) return { field: "artifactId", values: [filter.artifactId] };
  if (filter.specHash != null) return { field: "specHash", values: [filter.specHash] };
  if (filter.tenant != null) return { field: "tenant", values: [filter.tenant] };
  if (filter.type != null && filter.type.length > 0) return { field: "type", values: [...filter.type] };
  return null;
}

/** The exact predicate of the reference file port's listLineage (all conditions ANDed). */
export function matchesFilter(event: LineageEventRecord, filter: LineageFilter): boolean {
  if (filter.type != null && !filter.type.includes(event.type)) return false;
  if (filter.tenant != null && event.tenant !== filter.tenant) return false;
  if (filter.intentHash != null && payloadString(event, "intentHash") !== filter.intentHash) return false;
  if (filter.artifactId != null && payloadString(event, "artifactId") !== filter.artifactId) return false;
  if (filter.specHash != null && payloadString(event, "specHash") !== filter.specHash) return false;
  if (filter.since != null && !(event.ts >= filter.since)) return false;
  if (filter.until != null && !(event.ts <= filter.until)) return false;
  return true;
}

/** The most recent `limit` items in append order; `limit <= 0` is an empty list (parity with the file port / Python). */
export function tailLimit<T>(items: T[], limit: number | undefined): T[] {
  const n = limit ?? DEFAULT_LIMIT;
  if (n <= 0) return [];
  return items.slice(-n);
}

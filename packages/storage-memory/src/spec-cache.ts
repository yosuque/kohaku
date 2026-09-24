import type { UISpec } from "@kohaku-ui/spec-core";

/**
 * The entry cap of the in-memory Spec cache. On overflow, the oldest (least-recently-used) is dropped.
 * TTL is insurance for memory reclamation rather than data freshness; invalidation mainly happens naturally from
 * changes in key components (dataVersion / catalogFingerprint / generatorVersion).
 */
export const MAX_SPEC_CACHE_ENTRIES = 500;

export interface SpecCache {
  get(key: string): UISpec | null;
  put(key: string, spec: UISpec, ttlSeconds?: number): void;
}

/**
 * LRU (by Map insertion order, re-inserted on a hit) + optional per-entry TTL. Shared by the file-backed
 * and the pure in-memory StoragePort so the identical-display guarantee behaves the same in both.
 */
export function createSpecCache(maxEntries: number = MAX_SPEC_CACHE_ENTRIES): SpecCache {
  const entries = new Map<string, { spec: UISpec; expiresAt: number | null }>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (entry == null) return null;
      if (entry.expiresAt != null && entry.expiresAt < Date.now()) {
        entries.delete(key);
        return null;
      }
      // Re-insert the hit entry at the tail to maintain the LRU "recently used" order.
      entries.delete(key);
      entries.set(key, entry);
      return entry.spec;
    },
    put(key, spec, ttlSeconds) {
      entries.delete(key);
      entries.set(key, { spec, expiresAt: ttlSeconds != null ? Date.now() + ttlSeconds * 1000 : null });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}

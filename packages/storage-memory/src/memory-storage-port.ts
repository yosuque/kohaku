import type { FixationRecord, LineageEventRecord, PromotionState, StoragePort } from "@kohaku-ui/spec-core";
import { filterLineage, listByTenant, tenantKey } from "./shared.js";
import { createSpecCache } from "./spec-cache.js";

/**
 * A StoragePort that keeps everything in process memory: nothing survives a restart, and nothing is shared
 * across processes. This is the Zero-Port quickstart default (adoption-ladder Step 0) and the natural test
 * double; a product swaps in its own store, or `@kohaku-ui/storage-redis` / `@kohaku-ui/storage-postgres`,
 * before the identical-display guarantee has to hold across instances.
 *
 * Tenant scoping follows the same (tenant, id) key convention as the file-backed port (tenantKey), so the
 * contract suite in @kohaku-ui/port-contracts covers both identically.
 */
export function createMemoryStoragePort(): StoragePort {
  const specCache = createSpecCache();
  const lineage: LineageEventRecord[] = [];
  // Tracks ids already appended so a duplicate-id append is a no-op (StoragePort contract: appendLineage
  // is idempotent by id) without an O(n) scan of `lineage` on every append.
  const lineageIds = new Set<string>();
  const promotions = new Map<string, PromotionState>();
  const fixations = new Map<string, FixationRecord>();

  return {
    async getSpecCache(key) {
      return specCache.get(key);
    },
    async putSpecCache(key, spec, ttlSeconds) {
      specCache.put(key, spec, ttlSeconds);
    },
    async appendLineage(event) {
      // Idempotent by id: appending an event whose id already exists is a no-op (the second attempt of a
      // retried write must not duplicate the entry or move its position).
      if (lineageIds.has(event.id)) return;
      lineageIds.add(event.id);
      lineage.push(event);
    },
    async listLineage(filter) {
      return filterLineage(lineage, filter);
    },
    async getPromotionState(artifactId, tenant) {
      return promotions.get(tenantKey(tenant, artifactId)) ?? null;
    },
    async putPromotionState(state) {
      promotions.set(tenantKey(state.tenant, state.artifactId), state);
    },
    async putPromotionStates(states) {
      for (const state of states) promotions.set(tenantKey(state.tenant, state.artifactId), state);
    },
    async listPromotionStates(tenant) {
      return listByTenant(promotions, tenant);
    },
    async getFixation(intentHash, tenant) {
      return fixations.get(tenantKey(tenant, intentHash)) ?? null;
    },
    async putFixation(record, options) {
      const key = tenantKey(record.tenant, record.intentHash);
      // ifPresent: a self-healing get→put racing a concurrent delete must not resurrect the record.
      if (options?.ifPresent === true && !fixations.has(key)) return;
      fixations.set(key, record);
    },
    async listFixations(tenant) {
      return listByTenant(fixations, tenant);
    },
    async deleteFixation(intentHash, tenant) {
      fixations.delete(tenantKey(tenant, intentHash));
    },
  };
}

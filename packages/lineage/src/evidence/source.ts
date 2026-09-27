import type {
  FixationRecord,
  LineageEventRecord,
  LineageFilter,
  LineagePage,
  LineagePageRequest,
  PromotionState,
  StoragePort,
} from "@kohaku-ui/spec-core";

/**
 * Read-only source `buildEvidencePack` (build.ts) reads from: a paged/bounded view of the lineage
 * log, plus the current promotion and fixation snapshots. Kept as its own narrow interface --
 * distinct from `StoragePort` -- so a caller can build one over transports `@kohaku-ui/lineage`
 * itself has no business depending on (e.g. a REST host, via `@kohaku-ui/client`, which lives in a
 * sibling layer and is wired up by `cli` instead; see `createStorageEvidenceSource` below for the
 * one implementation this package does provide, over a local `StoragePort`).
 */
export interface EvidenceSource {
  /** Bounded tail window (mirrors `StoragePort.listLineage`) -- the only lineage read available when
   * `pageLineage` is absent (see build.ts's `allowIncomplete` handling). */
  listLineage(filter: LineageFilter): Promise<LineageEventRecord[]>;
  /** Exhaustive forward paging (mirrors `StoragePort.pageLineage`), when the backing store supports it. */
  pageLineage?(req: LineagePageRequest): Promise<LineagePage>;
  listPromotionStates(tenant?: string): Promise<PromotionState[]>;
  listFixations(tenant?: string): Promise<FixationRecord[]>;
}

/** Adapts a local `StoragePort` (e.g. `createFileStoragePort`'s data directory) into an `EvidenceSource`. */
export function createStorageEvidenceSource(storage: StoragePort): EvidenceSource {
  const source: EvidenceSource = {
    listLineage: (filter) => storage.listLineage(filter),
    listPromotionStates: (tenant) => storage.listPromotionStates(tenant),
    listFixations: (tenant) => storage.listFixations(tenant),
  };
  if (storage.pageLineage != null) {
    source.pageLineage = (req) => storage.pageLineage!(req);
  }
  return source;
}

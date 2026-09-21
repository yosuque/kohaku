import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { appendFile, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createKeyedMutex,
  type FixationRecord,
  type LineageEventRecord,
  LineageEventRecordSchema,
  type LineageFilter,
  type PromotionState,
  type StoragePort,
  type UISpec,
} from "@kohaku-ui/spec-core";

/**
 * StoragePort implementation (v0.1 extension).
 * The Spec cache is in-memory; Lineage / promotion / fixation are persisted to .data/
 * (promotions surviving a restart is essential for the demo).
 *
 * Persistence hardening and its limits (what is protected and what is not):
 * - Snapshots (promotions / fixations) are replaced atomically with tmp+rename. A reader never sees a
 *   mid-write intermediate state (rename is atomic on the filesystem).
 * - Each put does "re-read disk -> swap only that entry -> write back atomically", using `fs/promises` so a
 *   single state transition's I/O does not block the event loop (a compose that touches fixation self-healing,
 *   or an approve that writes several times, would otherwise stall concurrent requests). Within this process,
 *   concurrent put/delete calls that target the **same snapshot file** are serialized by a small in-process
 *   keyed mutex (createKeyedMutex, keyed by file path) — the read-modify-write for one call always completes
 *   before the next one for that file starts, so two concurrent puts (even for different tenant/id keys) cannot
 *   race and lose each other's entry. This mutex only orders calls made *within this process*; it is a single-writer
 *   assumption per process, not a cross-process lock.
 * - With truly concurrent writes across processes (the explicit scenario where sample-api and sample-mcp update the
 *   same .data simultaneously) a lost update can still occur: if both processes read the same snapshot, add their
 *   own entry, and write back, the later-winning rename drops the earlier entry. Robust cross-process sharing
 *   requires making it single-writer at the process level (or file locking / a DB).
 * - get returns the in-memory Map, so another process's changes are not reflected until this process's next put
 *   (= a re-read) (acceptable for demo use).
 * - listLineage likewise reads the in-memory array, so lineage appended by another process is invisible.
 *   Promotion-threshold aggregation (evaluateAndList) and fixation proposals also target only this process's lineage.
 * - lineage is only an in-memory array + appends to lineage.jsonl, with no cap or rotation / compaction. In long-term
 *   operation both the file and the startup load time grow without bound (a known constraint). For production use, the
 *   assumption is to swap in a dedicated event store / DB.
 */
/**
 * The entry cap of the in-memory Spec cache. On overflow, the oldest (least-recently-used) is dropped.
 * TTL is insurance for memory reclamation rather than data freshness; invalidation mainly happens naturally from
 * changes in key components (dataVersion / catalogFingerprint / generatorVersion).
 */
const MAX_SPEC_CACHE_ENTRIES = 500;

export function createFileStoragePort(dataDir: string): StoragePort {
  mkdirSync(dataDir, { recursive: true });
  const lineagePath = join(dataDir, "lineage.jsonl");
  const promotionsPath = join(dataDir, "promotions.json");
  const fixationsPath = join(dataDir, "fixations.json");

  // Keep the Map's insertion order as "most-recently-touched order" to approximate LRU (re-insert on a get hit).
  const specCache = new Map<string, { spec: UISpec; expiresAt: number | null }>();
  // Grows without a cap (no rotation/compaction). A known constraint. See the doc at the top for details.
  const lineage: LineageEventRecord[] = loadJsonl(lineagePath);
  // One in-process mutex, keyed by snapshot file path, so promotions.json and fixations.json serialize
  // independently of each other while each file's own put/delete calls run strictly one at a time (see the doc at the top).
  const fileLock = createKeyedMutex();
  const promotions = new TenantSnapshot<PromotionState>(promotionsPath, (fn) => fileLock(promotionsPath, fn));
  const fixations = new TenantSnapshot<FixationRecord>(fixationsPath, (fn) => fileLock(fixationsPath, fn));

  return {
    async getSpecCache(key) {
      const entry = specCache.get(key);
      if (entry == null) return null;
      if (entry.expiresAt != null && entry.expiresAt < Date.now()) {
        specCache.delete(key);
        return null;
      }
      // Re-insert the hit entry at the tail to maintain the LRU "recently used" order.
      specCache.delete(key);
      specCache.set(key, entry);
      return entry.spec;
    },
    async putSpecCache(key, spec, ttlSeconds) {
      // Delete an existing key first, then re-insert it, placing it at the tail (newest).
      specCache.delete(key);
      specCache.set(key, {
        spec,
        expiresAt: ttlSeconds != null ? Date.now() + ttlSeconds * 1000 : null,
      });
      // On overflow, drop from the oldest key (the head of the Map).
      while (specCache.size > MAX_SPEC_CACHE_ENTRIES) {
        const oldest = specCache.keys().next().value;
        if (oldest === undefined) break;
        specCache.delete(oldest);
      }
    },
    async appendLineage(event) {
      // Append with async I/O so the compose response is not blocked by the disk write (concurrent composes do not
      // serialize). Reflect to memory only after the append succeeds (so memory and disk do not diverge on append
      // failure); the on-exception behavior is the same as the synchronous version. Under concurrent appends the
      // completion order (= the in-memory array order and the JSONL line order) is not guaranteed to follow ts
      // order — a known limit of this file port; order-sensitive consumers pick by ts comparison, not by position.
      await appendFile(lineagePath, JSON.stringify(event) + "\n");
      lineage.push(event);
    },
    async listLineage(filter: LineageFilter = {}) {
      let result = lineage;
      if (filter.type != null) result = result.filter((e) => filter.type!.includes(e.type));
      // When tenant is specified, only matching events. Unspecified (single tenant) is all = legacy behavior.
      if (filter.tenant != null) result = result.filter((e) => e.tenant === filter.tenant);
      if (filter.intentHash != null) {
        result = result.filter((e) => e.payload["intentHash"] === filter.intentHash);
      }
      if (filter.artifactId != null) {
        result = result.filter((e) => e.payload["artifactId"] === filter.artifactId);
      }
      if (filter.specHash != null) {
        result = result.filter((e) => e.payload["specHash"] === filter.specHash);
      }
      if (filter.since != null) result = result.filter((e) => e.ts >= filter.since!);
      // Apply until "before" the tail slice (otherwise the latest limit entries get all excluded by until and the window is nearly empty).
      if (filter.until != null) result = result.filter((e) => e.ts <= filter.until!);
      const limit = filter.limit ?? 200;
      // limit <= 0 is an empty array (symmetric with the Python implementation; D1). Closes the trap where slice(-0)
      // === slice(0) returns all, and the behavior where a negative value returns other than the tail. Only a positive limit returns the tail limit entries.
      if (limit <= 0) return [];
      return result.slice(-limit);
    },
    async getPromotionState(artifactId, tenant) {
      // Key-separate by (tenant, artifactId). Unspecified tenant stays as artifactId =
      // matches the old promotions.json (no tenant) key, so legacy state loads compatibly as-is.
      // When tenant is specified, legacy (no-tenant) state is a different key and is invisible = treated as tenant-neutral.
      return promotions.get(tenant, artifactId);
    },
    async putPromotionState(state) {
      // Key-separate by (tenant, artifactId) using state.tenant. No tenant stays as artifactId.
      await promotions.put(state.artifactId, state);
    },
    async putPromotionStates(states) {
      // Batch counterpart of putPromotionState (P7 / the optional StoragePort extension): one read-modify-write
      // for every state instead of one per state, so a batch nomination pass (nominateEligible transitioning
      // many in_use candidates to candidate at once) does not re-read/re-stringify/re-write promotions.json
      // once per candidate.
      await promotions.putMany(states.map((state) => ({ id: state.artifactId, value: state })));
    },
    async listPromotionStates(tenant) {
      // When tenant is specified, only matching ones (unspecified is all = legacy behavior, including legacy no-tenant state).
      return promotions.list(tenant);
    },
    async getFixation(intentHash, tenant) {
      return fixations.get(tenant, intentHash);
    },
    async putFixation(record, options) {
      // Key-separate by (tenant, intentHash) using record.tenant. No tenant stays as intentHash.
      await fixations.put(record.intentHash, record, options);
    },
    async listFixations(tenant) {
      // When tenant is specified, only matching ones (unspecified is all = legacy behavior).
      return fixations.list(tenant);
    },
    // v0.1 extension (optional): releasing a fixation
    async deleteFixation(intentHash: string, tenant?: string) {
      await fixations.delete(tenant, intentHash);
    },
  };
}

/**
 * Holds one snapshot file (promotions.json / fixations.json) as an in-memory Map keyed by (tenant, id) via
 * tenantKey (the multi-tenant contract). Encapsulates the load-at-construction, tenant-filtered read
 * (get/list), and merge-write (put/delete: re-read disk -> mutate -> atomic write-back -> sync memory, including
 * the corruption-recovery merge base) shared between promotions and fixations instead of duplicating
 * fixationKey/promotionKey plus their mergePut/mergeDelete/tenant-filter call sites.
 *
 * `withLock` (bound by the caller to this instance's own file path) serializes put/delete against this snapshot
 * file within the process, so a read-modify-write started by one call always finishes before the next one for
 * the same file begins (see the module doc comment for what this does and does not guarantee).
 */
class TenantSnapshot<T extends { tenant?: string }> {
  private readonly map: Map<string, T>;

  constructor(
    private readonly path: string,
    private readonly withLock: <R>(fn: () => Promise<R>) => Promise<R>,
  ) {
    this.map = new Map(Object.entries(loadJson<Record<string, T>>(path, {})));
  }

  /** Looks up by (tenant, id). Key convention: an unspecified tenant is id itself. */
  get(tenant: string | undefined, id: string): T | null {
    return this.map.get(tenantKey(tenant, id)) ?? null;
  }

  /** Lists entries, optionally filtered to a tenant (unspecified = all, including legacy tenant-less entries). */
  list(tenant?: string): T[] {
    const values = [...this.map.values()];
    return tenant == null ? values : values.filter((v) => v.tenant === tenant);
  }

  /**
   * Merge-puts value at (value.tenant, id): re-read disk, update that key, write back atomically, sync memory.
   * `options.ifPresent`: when true, the write is a no-op (memory not synced either) unless that key is
   * already present in the freshly re-read disk snapshot — see mergePut's doc comment for why this exists.
   */
  put(id: string, value: T, options?: { ifPresent?: boolean }): Promise<void> {
    return this.withLock(() => mergePut(this.path, this.map, tenantKey(value.tenant, id), value, options));
  }

  /**
   * Merge-puts several (id, value) pairs in one read-modify-write (P7: avoids one full-file re-read +
   * re-stringify + atomic write-back per entry when a caller — e.g. nominateEligible's batch nomination —
   * needs to persist many entries at once). Semantically equivalent to calling `put` once per entry (same
   * tenantKey convention, same corruption-recovery merge base), just folded into a single disk round trip.
   * A no-op for an empty list (does not touch the file or take the lock).
   */
  putMany(entries: { id: string; value: T }[]): Promise<void> {
    if (entries.length === 0) return Promise.resolve();
    return this.withLock(() =>
      mergeMutate(this.path, this.map, (base) => {
        for (const { id, value } of entries) base[tenantKey(value.tenant, id)] = value;
      }),
    );
  }

  /** Merge-deletes (tenant, id): re-read disk, delete that key, write back atomically, sync memory. */
  delete(tenant: string | undefined, id: string): Promise<void> {
    return this.withLock(() => mergeDelete(this.path, this.map, tenantKey(tenant, id)));
  }
}

/**
 * The key convention shared by promotions.json and fixations.json (the multi-tenant contract).
 * An unspecified tenant (single tenant) is id itself = byte-matches the old (no-tenant) file's key, so an old file
 * loads compatibly as-is without conversion (legacy = tenant-neutral). Only when a tenant is specified:
 * `${tenant}\u0000${id}` (NUL separator; it appears in neither a tenant identifier nor an artifactId / intentHash,
 * so the composite key does not collide).
 */
function tenantKey(tenant: string | undefined, id: string): string {
  return tenant != null && tenant !== "" ? `${tenant}\u0000${id}` : id;
}

/**
 * Reads the latest from disk, mutates that entry via mutate, writes it back atomically, and syncs the memory Map too
 * (the common part of mergePut / mergeDelete). Uses `fs/promises` throughout (TenantSnapshot's withLock already
 * serializes concurrent calls against the same path within this process, so this itself does not need to be atomic
 * with respect to other in-process callers — only with respect to another process, which it is not; see the
 * module doc comment).
 * If the disk was corrupted during execution, use **the memory Map as the merge base** rather than fallback({})
 * (using corruption as the base would collapse all healthy state into that single entry and lose it. The corrupted file
 * has already been moved aside to .corrupt by loadJsonSnapshotAsync, so writing back the full memory recovers it).
 * `mutate` may return `false` to signal "no change to persist" (a conditional write, e.g. mergePut's
 * `ifPresent` bailing out because the key is absent). In that case the atomic write-back is skipped (nothing
 * changed, so there is nothing to persist), but the memory Map is still synced to `base` — the freshly
 * re-read disk snapshot (or, on corruption, the pre-existing memory-derived fallback). This is what lets a
 * skipped self-healing put (§2 review finding: a stale in-memory copy racing a concurrent delete) also
 * refresh this process's stale view: the caller's in-memory copy of a record another writer already deleted
 * gets dropped from memory too, rather than lingering there until an unrelated key's put happens to resync it.
 */
async function mergeMutate<T>(
  path: string,
  memory: Map<string, T>,
  mutate: (base: Record<string, T>) => boolean | undefined,
): Promise<void> {
  const loaded = await loadJsonSnapshotAsync<Record<string, T>>(path, {});
  const base = loaded.corrupted ? Object.fromEntries(memory) : loaded.data;
  const shouldPersist = mutate(base) !== false;
  if (shouldPersist) await writeJsonAtomicAsync(path, base);
  syncMemory(memory, base);
}

/**
 * Reads the latest from disk, updates that key, writes it back atomically, and syncs the memory Map too.
 * `options.ifPresent`: skip the write-back (memory is still synced to the freshly re-read disk snapshot; see
 * mergeMutate's doc comment) unless `key` is already present there. Used by `Fixations.refreshFingerprint`
 * (via `StoragePort.putFixation`'s options) so a self-healing get→put that races with a concurrent delete
 * does not resurrect an already-removed fixation (§2 review finding: sample-api and sample-mcp sharing one
 * `.data` directory could otherwise revive a fixation deleted by the other process's `unfixate`).
 */
function mergePut<T>(
  path: string,
  memory: Map<string, T>,
  key: string,
  value: T,
  options?: { ifPresent?: boolean },
): Promise<void> {
  return mergeMutate(path, memory, (base) => {
    if (options?.ifPresent === true && !(key in base)) return false;
    base[key] = value;
  });
}

/** Reads the latest from disk, deletes that key, writes it back atomically, and syncs the memory Map too. */
function mergeDelete<T>(path: string, memory: Map<string, T>, key: string): Promise<void> {
  return mergeMutate(path, memory, (base) => {
    delete base[key];
  });
}

function syncMemory<T>(memory: Map<string, T>, record: Record<string, T>): void {
  memory.clear();
  for (const [k, v] of Object.entries(record)) memory.set(k, v);
}

/**
 * Atomic write that writes to tmp then renames (async; used by the runtime merge path — mergeMutate).
 * Guarantee scope: process-crash resilience only (rename is atomic, so a mid-write intermediate state is never read as
 * the real file). Since it does not fsync, it does not guarantee data durability across a power loss, kernel panic, etc.
 * (that the post-rename content has definitely reached disk).
 * On any failure after the tmp file is created (the write itself, or the rename), the tmp file is removed so a
 * failed write does not leave an orphaned `*.tmp` file behind.
 */
async function writeJsonAtomicAsync(path: string, data: unknown): Promise<void> {
  // The tmp name adds a unique suffix in addition to the PID. So that tmp files do not collide even during
  // cross-process concurrency where the PID happens to match across a separate PID namespace (a container).
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  let renamed = false;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, path);
    renamed = true;
  } finally {
    if (!renamed) await unlink(tmp).catch(() => {});
  }
}

function loadJsonl(path: string): LineageEventRecord[] {
  if (!existsSync(path)) return [];
  const out: LineageEventRecord[] = [];
  let skipped = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A trailing in-progress line or corrupted JSON (recovery from a crash mid-append).
      skipped++;
      continue;
    }
    // JSON-valid but schema-invalid rows (a hand-edited or pre-migration line, or one written by an older
    // record shape) must not reach downstream consumers of `lineage` (listLineage / promotion evaluation /
    // fixation stability tallies), which trust every entry's shape without re-validating it themselves.
    // Route the same warn-and-skip path as a JSON parse failure, rather than a distinct throw, so one bad
    // row degrades gracefully instead of aborting startup.
    const result = LineageEventRecordSchema.safeParse(parsed);
    if (!result.success) {
      skipped++;
      continue;
    }
    out.push(result.data as LineageEventRecord);
  }
  if (skipped > 0) {
    console.warn(`[storage] Skipped ${skipped} malformed/invalid line(s) in lineage.jsonl`);
  }
  return out;
}

/** True for a JSON value shaped like `{key -> record}` (rejects `null`, arrays, and primitives). Every
 * snapshot file (promotions.json / fixations.json) is this shape; a root of any other shape parses but is
 * not usable and is treated as corrupted. */
function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The legacy API for startup loading (on corruption, move aside and fall back; the caller does not distinguish corrupted or not). */
function loadJson<T>(path: string, fallback: T): T {
  return loadJsonSnapshot(path, fallback).data;
}

/**
 * Reads a snapshot JSON and returns it along with **whether corruption was detected**.
 * On corruption, moves it aside to .corrupt so it is noticeable, then returns fallback. The caller can choose a
 * degradation policy based on corrupted (startup = restart with empty state; runtime merge = write back the full memory Map as the base).
 */
function loadJsonSnapshot<T>(path: string, fallback: T): { data: T; corrupted: boolean } {
  if (!existsSync(path)) return { data: fallback, corrupted: false };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    // The snapshot format is always a {key -> record} object. `null` (JSON.parse("null") succeeds and would
    // TypeError on the caller's Object.entries) and an array (silently drops all entries when written back as
    // {key -> record}, D3) are both malformed roots even though they parse — treat them the same as a parse
    // failure (move aside to .corrupt, fall back).
    if (!isPlainJsonObject(parsed)) throw new Error(`${path}: JSON root is not a plain object`);
    return { data: parsed as T, corrupted: false };
  } catch {
    // Silently reinitializing on corruption would lose approved state. Move it aside so it is noticeable, then fall back.
    try {
      const backup = `${path}.${Date.now()}.corrupt`;
      renameSync(path, backup);
      console.warn(`[storage] ${path} was corrupted, so it was moved aside to ${backup}`);
    } catch {
      console.warn(`[storage] ${path} is corrupted`);
    }
    return { data: fallback, corrupted: true };
  }
}

/**
 * Async counterpart of loadJsonSnapshot, used by the runtime merge path (mergeMutate, i.e. put/delete) so a
 * read-modify-write does not block the event loop. Semantics match the sync version exactly: file absence
 * (ENOENT) is "not corrupted, fallback"; any other read error propagates; a parse failure is "corrupted" and
 * moves the file aside to .corrupt.
 */
async function loadJsonSnapshotAsync<T>(path: string, fallback: T): Promise<{ data: T; corrupted: boolean }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { data: fallback, corrupted: false };
    throw e;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    // See loadJsonSnapshot's comment: null / array roots parse successfully but are not the {key -> record}
    // shape every snapshot file uses, so treat them as corrupted too.
    if (!isPlainJsonObject(parsed)) throw new Error(`${path}: JSON root is not a plain object`);
    return { data: parsed as T, corrupted: false };
  } catch {
    // Silently reinitializing on corruption would lose approved state. Move it aside so it is noticeable, then fall back.
    try {
      const backup = `${path}.${Date.now()}.corrupt`;
      await rename(path, backup);
      console.warn(`[storage] ${path} was corrupted, so it was moved aside to ${backup}`);
    } catch {
      console.warn(`[storage] ${path} is corrupted`);
    }
    return { data: fallback, corrupted: true };
  }
}

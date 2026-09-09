import type { ComposePolicy, FewShotExample } from "@kohaku-ui/composer";
import type { CanonicalIntent, FixationRecord, StoragePort } from "@kohaku-ui/spec-core";

/** Default TTL for createFixationFewShot's short-lived fixation-list cache (see its doc). */
const DEFAULT_FIXATION_CACHE_MS = 1000;

/**
 * A source that maps fixations (L0) to good few-shot examples (3-9).
 *
 * A fixated Spec belongs to the population "recognized as a good composition through human review", making it ideal
 * as a model for L1 generation. listFixations() is stably sorted by **canonical match first -> intentHash ascending**,
 * and only the components / events of the first 2 pinnedSpecs are placed as examples (provenance, etc. are dropped for budget).
 *
 * **Determinism**: for the same input (the same fixation set, the same intent), always returns the same order and the
 * same 2 entries. This determinism is the premise for cache consistency (same intent -> same prompt -> same generation).
 * Swapping this source in / out is a change in prompt content, so it is handled by the practice of bumping generatorVersion (docs/design.md §few-shot).
 *
 * **Caching**: examples() is called once per L1 generation (not per repair attempt), but that is still once
 * per compose — a full listFixations() copy + sort on every single one is wasted work between the (typically
 * rare) moments a fixation is actually approved or removed. The full fixation list, and each canonical's
 * sorted derivation of it, are cached for up to `cacheMs` (default 1s): a fixation change is visible to new
 * compose calls within at most that window, and every compose landing inside it reuses the cached sort
 * instead of redoing it. Kept storage-implementation-agnostic (bounded by wall-clock time alone, not a
 * StoragePort extension or the file-backed port's on-disk mtime/size) — the minimal viable bound for this
 * "Minor" cost, not a correctness-relevant cache (never serves data more than `cacheMs` stale).
 */
export function createFixationFewShot(
  storage: StoragePort,
  options?: { cacheMs?: number },
): NonNullable<ComposePolicy["fewShot"]> {
  const cacheMs = options?.cacheMs ?? DEFAULT_FIXATION_CACHE_MS;
  let cachedAt = 0;
  let cachedFixations: readonly FixationRecord[] | null = null;
  // Invalidated (cleared) every time cachedFixations itself refreshes, so a stale sort is never reused
  // across a fixation-list refresh even if the TTL window happens to straddle it.
  const sortedByCanonical = new Map<string, FixationRecord[]>();

  async function getFixations(): Promise<readonly FixationRecord[]> {
    const now = Date.now();
    if (cachedFixations != null && now - cachedAt < cacheMs) return cachedFixations;
    cachedFixations = await storage.listFixations();
    cachedAt = now;
    sortedByCanonical.clear();
    return cachedFixations;
  }

  return {
    async examples(intent: CanonicalIntent): Promise<FewShotExample[]> {
      const fixations = await getFixations();
      let sorted = sortedByCanonical.get(intent.canonical);
      if (sorted == null) {
        sorted = sortFixations(fixations, intent.canonical);
        sortedByCanonical.set(intent.canonical, sorted);
      }
      return sorted.slice(0, 2).map((f) => ({
        intent: { canonical: f.pinnedSpec.intent.canonical, params: f.pinnedSpec.intent.params },
        spec: { components: f.pinnedSpec.components, events: f.pinnedSpec.events },
      }));
    },
  };
}

/**
 * Stable sort: fixations matching the given canonical first, then intentHash ascending.
 * Since intentHash is sha256-derived and unique, the order is deterministic even when a tie-break occurs.
 */
function sortFixations(fixations: readonly FixationRecord[], canonical: string): FixationRecord[] {
  return [...fixations].sort((a, b) => {
    const aMatch = a.canonical === canonical ? 0 : 1;
    const bMatch = b.canonical === canonical ? 0 : 1;
    if (aMatch !== bMatch) return aMatch - bMatch;
    return a.intentHash < b.intentHash ? -1 : a.intentHash > b.intentHash ? 1 : 0;
  });
}

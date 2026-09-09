import { canonicalStringify, sha256Hex } from "./canonical-json.js";
import type { ComponentNode } from "./schema/component.js";
import { SPEC_VERSION, type UISpec } from "./schema/spec.js";

export interface CacheKeyParts {
  intentHash: string;
  dataVersion: string;
  /** A component that keeps a stale Spec from being mistaken for a current one when the catalog is revised. */
  catalogFingerprint?: string;
  specVersion?: string;
  /**
   * The generator version. An optional component that separates the cache across prompt revisions or
   * model changes. If omitted, the key matches the legacy 5-component key exactly (so introducing this
   * component does not blow away every existing cache entry).
   */
  generatorVersion?: string;
  /**
   * A fingerprint of the ComposePolicy fields that affect prompt content but were not otherwise reflected
   * in the cache key (outputLanguage / designSystem / fewShot.id / selectComponents.id — see
   * @kohaku-ui/composer's policyFingerprint). Appended as the 7th component, after generatorVersion.
   * If omitted (or the empty string), the key is completely unchanged from before this field existed —
   * introducing it alone does not invalidate any existing cache entry. Because this component sits after
   * generatorVersion positionally, a "-" placeholder is inserted in the generatorVersion slot when this is
   * given but generatorVersion is not, so the two never collide on the same string for different inputs.
   */
  policyFingerprint?: string;
}

/** Spec cache key (Intent + data version, plus the catalog fingerprint). */
export function cacheKey(parts: CacheKeyParts): string {
  const segments = [
    "kohaku",
    parts.specVersion ?? SPEC_VERSION,
    parts.intentHash,
    parts.dataVersion,
    parts.catalogFingerprint ?? "-",
  ];
  const hasPolicyFingerprint = parts.policyFingerprint != null && parts.policyFingerprint !== "";
  // generatorVersion is appended as the 6th component when specified, or as a "-" placeholder when
  // policyFingerprint (the 7th component) is given without it — keeping the two positionally distinct so
  // a generatorVersion-only key can never collide with a policyFingerprint-only key. If neither is given,
  // the string matches the legacy 5-component key exactly, so introducing either component alone does not
  // invalidate every existing cache entry at once.
  if (parts.generatorVersion != null || hasPolicyFingerprint) {
    segments.push(parts.generatorVersion ?? "-");
  }
  if (hasPolicyFingerprint) segments.push(parts.policyFingerprint!);
  return segments.join(":");
}

/** One $ref's URI and its resolved dataVersion, the input unit for combineDataVersions. */
export interface RefVersionEntry {
  uri: string;
  version: string;
}

/**
 * Deterministically combines the dataVersion of multiple QueryHandles.
 * Collapses identical versions: when several $refs point at the same data source (a KPI list, etc.),
 * they normalize to a single version that can be matched directly against each $ref's response
 * dataVersion. Without deduplication, even identical versions would become a `multi:` value and the
 * Renderer's dataVersion matching would always judge STALE. This single-version shortcut is why the
 * function keeps returning the bare version string (never a `multi:` wrapper) whenever there is only
 * one distinct version, even though the input is now URI-aware.
 *
 * The combined hash is uri-aware (`uri=version` pairs, sorted, then hashed) rather than a hash of the
 * version values alone, so that `{a: v1, b: v2}` and `{a: v2, b: v1}` never collapse onto the same
 * cache key merely because the same two version strings happen to appear.
 */
export async function combineDataVersions(entries: RefVersionEntry[]): Promise<string> {
  const unique = [...new Set(entries.map((e) => e.version))];
  if (unique.length === 0) return "none";
  if (unique.length === 1) return unique[0]!;
  const pairs = entries.map((e) => `${e.uri}=${e.version}`);
  const sorted = [...pairs].sort();
  const hex = await sha256Hex(sorted.join("|"));
  // 64 bits (16 hex) is enough: a multi: value represents several distinct data versions and, in
  // STALE checks, never matches a single dataVersion, so a collision is harmless. As a cache-key
  // component a theoretical birthday-collision margin remains, but the impact is negligible.
  return `multi:${hex.slice(0, 16)}`;
}

/** Deterministic hash of the whole Spec (used for View Lineage and the specHash reference on /events). */
export async function computeSpecHash(spec: UISpec): Promise<string> {
  const hex = await sha256Hex(canonicalStringify(spec));
  return `sha256:${hex}`;
}

/** One computeStructureHash memo entry: the events/state it was computed against (for a cheap staleness check) + the resulting promise. */
interface StructureHashMemo {
  events: UISpec["events"];
  state: UISpec["state"];
  promise: Promise<string>;
}

/**
 * Memoizes computeStructureHash by the Spec's `components` array reference. A cache hit that returns the
 * same in-memory UISpec object on repeated lookups (a common StoragePort.getSpecCache shape) keeps that
 * object's `components` array reference stable across requests, so re-hashing it on every single request
 * (once per view.composed recording) is pure waste — this lets such repeats reuse the first computation.
 * A Spec whose storage round-trips through JSON (a fresh array each time) simply never hits the cache here
 * and pays the same cost as before it existed (no correctness risk either way).
 *
 * Keyed only by the `components` reference, with `events`/`state` reference-checked on hit: if either
 * differs from what the cached promise was computed against (a components array reused across genuinely
 * different Specs), the entry is recomputed rather than trusted — so a rare reference reuse can never
 * silently return a stale hash for the wrong content.
 */
const structureHashMemo = new WeakMap<ComponentNode[], StructureHashMemo>();

/**
 * Structure-only hash (components + events; excludes provenance / dataVersion).
 * Used to judge the "structural stability" of L1→L0 fixation: how consistently the same Intent
 * emits the same structure across different dataVersions is measured by this hash's match rate.
 *
 * state is included in the input **only when it exists**. The hash of an existing Spec without state
 * (0.1-era, or 0.2 that does not use state) stays completely unchanged from the legacy value,
 * protecting the fixation stability tally. Since state is the very branch point of the display
 * condition (visibleWhen), when declared it is folded in as part of the structure.
 */
export function computeStructureHash(spec: UISpec): Promise<string> {
  const cached = structureHashMemo.get(spec.components);
  if (cached != null && cached.events === spec.events && cached.state === spec.state) {
    return cached.promise;
  }
  const promise = computeStructureHashUncached(spec);
  structureHashMemo.set(spec.components, { events: spec.events, state: spec.state, promise });
  return promise;
}

/** The uncached computation body, kept `async` so a synchronous canonicalStringify throw (a non-finite
 * number, etc.) surfaces as a rejected Promise exactly as it did before memoization was added, rather than
 * escaping computeStructureHash as a synchronous throw. */
async function computeStructureHashUncached(spec: UISpec): Promise<string> {
  const structure =
    spec.state != null
      ? { components: spec.components, events: spec.events, state: spec.state }
      : { components: spec.components, events: spec.events };
  const hex = await sha256Hex(canonicalStringify(structure));
  return `sha256:${hex}`;
}

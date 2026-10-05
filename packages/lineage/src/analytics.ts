import type { LineageEventRecord } from "@kohaku-ui/spec-core";

/**
 * Usage analytics. A pure function that folds the raw lineage event stream (the LineageEventRecord[]
 * returned by GET /lineage) into an aggregate summary through which operators can survey the fallback rate,
 * tier distribution, and latency.
 *
 * Design approach:
 * - **Read-only**. It never modifies the event schema (the type catalog / payload in events.ts). It aggregates
 *   "as far as it can" from already-recorded payloads (view.composed's tier / cache / durationMs / intentHash /
 *   canonical, view.fallback's kind, etc.). It does not require any new payload field.
 * - Pure function. It aggregates by looking only at the input array, holding no I/O and no clock (easy to test,
 *   cache-safe).
 * - Scope narrowing (tenant / since / until) is also taken as arguments to pre-filter the array. The route side
 *   passes an array already narrowed by the window via storage's listLineage, but this function alone can do the
 *   same narrowing (double application is idempotent).
 */

/** One row for a frequently-used intent (per view.composed intentHash, with canonical noted alongside). */
export interface IntentUsage {
  intentHash: string;
  canonical: string;
  count: number;
}

/** Lineage aggregate summary (the body of the analytics.read response). */
export interface LineageSummary {
  /** Total number of events aggregated (after narrowing by tenant / since / until). */
  events: number;
  /** Count of view.composed (number of successful view presentations). */
  composed: number;
  /** Tier distribution (view.composed's payload.tier). */
  tiers: { L0: number; L1: number; L2: number };
  /**
   * Cache breakdown (view.composed's payload.cache). The 4 known kinds (hit/miss/bypass/fixated) + anything
   * unexpected goes to other. The provenance.cache vocabulary is owned by the composer (this function only
   * counts the known vocabulary and lumps unknown values into other).
   */
  cache: { hit: number; miss: number; bypass: number; fixated: number; other: number };
  /** Fallback (view.fallback). */
  fallback: {
    total: number;
    /** Per kind (generation / negotiation; an unspecified payload.kind counts as unspecified). */
    byKind: { generation: number; negotiation: number; unspecified: number };
    /**
     * Fallback rate = total / (composed + total). "The fraction of view-presentation attempts that dropped to
     * fallback." When the denominator is 0 (no presentations and no fallbacks) it is 0. A real number in 0..1.
     */
    rate: number;
  };
  /**
   * Quantiles of view.composed's payload.durationMs (milliseconds). Only events that carry durationMs as a number
   * form the population (the "aggregate as far as you can" policy; older events without durationMs are excluded
   * from the population). When the population is 0 the quantiles are null. Quantiles are nearest-rank
   * (the ceil(p/100 · n)-th value).
   */
  durationMs: {
    count: number;
    p50: number | null;
    p95: number | null;
    p99: number | null;
    max: number | null;
  };
  /** Top N frequently-used intents (per view.composed intentHash, in descending count order. Default N=10). */
  topIntents: IntentUsage[];
  /** Event counts for the promotion lifecycle (each component.* transition). */
  promotions: {
    generated: number;
    used: number;
    nominated: number;
    /** component.schemaSuggested (a machine proposal was attached at nomination). */
    schemaSuggested: number;
    judged: number;
    reviewed: number;
    /** component.schemaEdited (a reviewer approved a candidate that carried a suggestion; changed may be empty). */
    schemaEdited: number;
    published: number;
    withdrawn: number;
  };
  /**
   * Human review turnaround: the time from a candidate's `component.nominated` to the next `component.reviewed`
   * whose decision is approve or reject, paired per (tenant, artifactId). A requestChanges decision does not
   * complete a review: the candidate is re-nominated later, but a re-nomination for a candidate whose window is
   * already open does not restart the measurement (the original nomination's window stays open until a
   * closing review consumes it) -- so a re-submitted candidate ("re-submit and approve", whose fresh
   * `component.nominated` can land milliseconds before its own `component.reviewed`) is measured from its
   * *original* nomination, including the time spent making the requested changes, rather than a near-zero
   * duration from the resubmission. A reviewed event with no preceding open nomination in the window is
   * ignored.
   *
   * The pairing scans a **stably sorted-by-`ts` copy** of `events` (ties broken by original array position) and
   * treats each `component.nominated` as opening the window that the next matching `component.reviewed`
   * closes, so a caller does not need to guarantee `events` is already in ascending `ts` order itself (e.g. a
   * reviewed record that happens to sit before its own nomination in the input array still pairs correctly, as
   * long as its timestamp is later).
   *
   * `count` is the number of *paired* durations that made it into `durationMs`, not the number of
   * approve/reject `component.reviewed` events -- a pair whose computed delta fails the finite/non-negative
   * guard (out-of-order or malformed timestamps) is silently dropped from both `count` and the quantiles.
   *
   * Quantiles are nearest-rank like durationMs. `acceptedAsIs` counts `component.schemaEdited` records whose
   * `changed` is empty **and** whose `acknowledged` is `true` (the reviewer both made no edits and ticked the
   * acknowledgement checkbox) — the ticket's "zero-edit approval" KPI. A record with no `acknowledged` field at
   * all (written before that field existed) does not count, the same as one with `acknowledged: false`.
   */
  review: {
    count: number;
    durationMs: { p50: number | null; p95: number | null; max: number | null };
    acceptedAsIs: number;
  };
  /** Fixation event counts (intent.fixated / intent.unfixated). */
  fixations: { fixated: number; unfixated: number };
  /**
   * Per-day, per-tenant usage rows over the same window (`summarizeUsage(scoped, { bucket: "day" })`). Day
   * ascending, tenant ascending; an unrecorded tenant is the empty string.
   */
  usage: UsageRow[];
  /**
   * Catalog gap: the Intents that fell to free-form L2 generation (view.composed of tier L2 with cache miss or
   * bypass), aggregated per `canonical` and ordered by `generated` descending (top N, N as for `topIntents`).
   * `intentHash` is the first one seen for that canonical (a representative; the same canonical can recur
   * with different params). `fallbacks` counts the `view.fallback` records whose intentHash maps back to this
   * canonical through the window's view.composed records (a fallback for an intent never composed in the
   * window cannot be attributed and is not counted). A canonical with no L2 generation has no row.
   */
  l2ByIntent: L2IntentGap[];
  /**
   * Catalog gap: where reviewers had to correct the machine's schema suggestion. Counts `component.schemaEdited`
   * records whose `changed` is non-empty, grouped by the component type the reviewer finally proposed (the
   * `draft.componentType` of the same artifact's `component.schemaProposed`; the artifactId when none is
   * recorded in the window), ordered by `count` descending (top N, N as for `topIntents`). `topFields` is the
   * five most-changed draft fields of that group.
   */
  schemaEditsByComponent: SchemaEditGap[];
}

/** One row of `LineageSummary.l2ByIntent`. */
export interface L2IntentGap {
  canonical: string;
  intentHash: string;
  generated: number;
  fallbacks: number;
}

/** One row of `LineageSummary.schemaEditsByComponent`. */
export interface SchemaEditGap {
  /** The final component type, or the artifactId when no `component.schemaProposed` names one. */
  key: string;
  count: number;
  topFields: { field: string; count: number }[];
}

/**
 * One metering row: everything countable about one tenant on one UTC day, derived purely from lineage
 * (design.md #74). `l2Generated` counts view.composed events of tier L2 whose cache was miss or bypass (an L2
 * Spec that was actually generated rather than served from the cache or a fixation); `tokens` sums
 * `view.composed`'s `payload.decision.usage` (a single-flight follower carries no usage, so it never double-counts).
 */
export interface UsageRow {
  /** UTC calendar day, `YYYY-MM-DD` (the first 10 characters of the record's `ts`). */
  day: string;
  /** The record's tenant; the empty string when the record carries none. */
  tenant: string;
  composed: number;
  cache: { hit: number; miss: number; bypass: number; fixated: number };
  tiers: { L0: number; L1: number; L2: number };
  l2Generated: number;
  /** view.fallback records. */
  fallbacks: number;
  tokens: { input: number; output: number };
  /** intent.fixated / intent.unfixated records. */
  fixated: number;
  unfixated: number;
}

/** Options for summarizeUsage. */
export interface SummarizeUsageOptions {
  /** The bucket width. Only "day" (UTC) exists. */
  bucket: "day";
  /** Aggregate only records whose record.tenant matches. */
  tenant?: string;
  /** Aggregate only events at or after this time (record.ts >= since). */
  since?: string;
  /** Aggregate only events at or before this time (record.ts <= until). */
  until?: string;
}

/** Narrowing and shaping options for summarizeLineage. */
export interface SummarizeLineageOptions {
  /** Narrow by tenant (aggregate only records whose record.tenant matches). Older events without a recorded tenant are excluded as non-matching. */
  tenant?: string;
  /** Aggregate only events at or after this time (record.ts >= since). Expects canonical ISO8601 (the route normalizes before passing). */
  since?: string;
  /** Aggregate only events at or before this time (record.ts <= until). Expects canonical ISO8601. */
  until?: string;
  /** N for topIntents, l2ByIntent and schemaEditsByComponent. Default 10, clamped to 1..50. */
  topIntentsLimit?: number;
}

const TOP_INTENTS_DEFAULT = 10;
const TOP_INTENTS_MAX = 50;
const SCHEMA_EDIT_TOP_FIELDS = 5;

/** Folds the raw lineage event stream into an aggregate summary (pure, read-only). */
export function summarizeLineage(
  events: readonly LineageEventRecord[],
  opts: SummarizeLineageOptions = {},
): LineageSummary {
  const scoped = events.filter((e) => {
    if (opts.tenant != null && e.tenant !== opts.tenant) return false;
    if (opts.since != null && e.ts < opts.since) return false;
    if (opts.until != null && e.ts > opts.until) return false;
    return true;
  });

  const tiers = { L0: 0, L1: 0, L2: 0 };
  const cache = { hit: 0, miss: 0, bypass: 0, fixated: 0, other: 0 };
  const byKind = { generation: 0, negotiation: 0, unspecified: 0 };
  const promotions = {
    generated: 0,
    used: 0,
    nominated: 0,
    schemaSuggested: 0,
    judged: 0,
    reviewed: 0,
    schemaEdited: 0,
    published: 0,
    withdrawn: 0,
  };
  const fixations = { fixated: 0, unfixated: 0 };
  const durations: number[] = [];
  // intentHash → { canonical (first seen), count }. Preserves insertion order while taking the top items by descending count.
  const intents = new Map<string, { canonical: string; count: number }>();
  // Catalog-gap inputs. canonical -> L2 generation row; intentHash -> canonical (from every view.composed, so a
  // view.fallback, which carries only the hash, can be attributed); the fallbacks' hashes, resolved after the
  // pass so the result does not depend on whether a fallback sorts before its composed record.
  const l2Rows = new Map<string, L2IntentGap>();
  const canonicalOfHash = new Map<string, string>();
  const fallbackHashes: string[] = [];
  // (tenant, artifactId) -> the final component type of the latest component.schemaProposed; and the edits
  // (non-empty `changed`) to group once that map is complete.
  const proposedType = new Map<string, string>();
  const schemaEdits: { key: string; artifactId: string; fields: string[] }[] = [];

  let composed = 0;
  let fallbackTotal = 0;
  // (tenant, artifactId) -> ts of the latest nomination not yet closed by an approve/reject review.
  const openNominations = new Map<string, string>();
  const reviewDurations: number[] = [];
  let acceptedAsIs = 0;
  const reviewKey = (e: LineageEventRecord): string =>
    `${e.tenant ?? ""}\u0000${String(e.payload["artifactId"] ?? "")}`;

  // Stable-sort by ts (ties broken by original array position) before the main pass. Every aggregation below
  // other than `review`'s nominated/reviewed pairing is order-independent (plain counts / sums / "first seen"
  // maps), so this only changes `review`'s behavior in practice, but sorting once up front is simpler than
  // special-casing just that one pairing loop.
  const ordered = scoped
    .map((e, index) => ({ e, index }))
    .sort((a, b) => (a.e.ts < b.e.ts ? -1 : a.e.ts > b.e.ts ? 1 : a.index - b.index))
    .map(({ e }) => e);

  for (const e of ordered) {
    switch (e.type) {
      case "view.composed": {
        composed++;
        const tier = String(e.payload["tier"] ?? "");
        if (tier === "L0" || tier === "L1" || tier === "L2") tiers[tier]++;
        const cacheKey = String(e.payload["cache"] ?? "");
        if (cacheKey === "hit" || cacheKey === "miss" || cacheKey === "bypass" || cacheKey === "fixated") {
          cache[cacheKey]++;
        } else {
          cache.other++;
        }
        const d = e.payload["durationMs"];
        if (typeof d === "number" && Number.isFinite(d)) durations.push(d);
        const intentHash = e.payload["intentHash"];
        if (typeof intentHash === "string" && intentHash.length > 0) {
          const prev = intents.get(intentHash);
          if (prev != null) prev.count++;
          else intents.set(intentHash, { canonical: String(e.payload["canonical"] ?? ""), count: 1 });
        }
        const canonical = String(e.payload["canonical"] ?? "");
        if (typeof intentHash === "string" && intentHash.length > 0 && !canonicalOfHash.has(intentHash)) {
          canonicalOfHash.set(intentHash, canonical);
        }
        if (tier === "L2" && (cacheKey === "miss" || cacheKey === "bypass")) {
          const row = l2Rows.get(canonical);
          if (row != null) {
            row.generated++;
            if (row.intentHash === "" && typeof intentHash === "string") row.intentHash = intentHash;
          } else {
            l2Rows.set(canonical, {
              canonical,
              intentHash: typeof intentHash === "string" ? intentHash : "",
              generated: 1,
              fallbacks: 0,
            });
          }
        }
        break;
      }
      case "view.fallback": {
        const fallbackHash = e.payload["intentHash"];
        if (typeof fallbackHash === "string" && fallbackHash.length > 0) fallbackHashes.push(fallbackHash);
        fallbackTotal++;
        const kind = e.payload["kind"];
        if (kind === "generation" || kind === "negotiation") byKind[kind]++;
        else byKind.unspecified++;
        break;
      }
      case "component.generated":
        promotions.generated++;
        break;
      case "component.used":
        promotions.used++;
        break;
      case "component.nominated": {
        promotions.nominated++;
        // Only open a *fresh* window when none is already open for this (tenant, artifactId): a re-nomination
        // for a candidate whose window is already open (the "re-submit and approve" flow routes a
        // changes_requested candidate back through `act(..., { kind: "nominate", by: reviewer }, ...)`,
        // service.ts, recording a fresh component.nominated milliseconds before its own component.reviewed)
        // does not restart the measurement -- the original nomination's window stays open, so a re-submitted
        // candidate is still measured from its original nomination, including the time spent making the
        // requested changes. This does not key off payload.by (a field docs/specification.md's
        // component.nominated row does not promise as part of the wire contract): any nomination path can open
        // the *first* window for a given candidate, including one driven purely through the generic actions
        // route with no `by: "policy"` sentinel ever recorded.
        const key = reviewKey(e);
        if (!openNominations.has(key)) openNominations.set(key, e.ts);
        break;
      }
      case "component.schemaSuggested":
        promotions.schemaSuggested++;
        break;
      case "component.judged":
        promotions.judged++;
        break;
      case "component.reviewed": {
        promotions.reviewed++;
        const decision = e.payload["decision"];
        if (decision === "approve" || decision === "reject") {
          const key = reviewKey(e);
          const nominatedAt = openNominations.get(key);
          if (nominatedAt != null) {
            const delta = Date.parse(e.ts) - Date.parse(nominatedAt);
            if (Number.isFinite(delta) && delta >= 0) reviewDurations.push(delta);
            openNominations.delete(key);
          }
        }
        break;
      }
      case "component.schemaEdited": {
        promotions.schemaEdited++;
        const changed = e.payload["changed"];
        // acceptedAsIs requires BOTH no edits AND an explicit acknowledgement (payload.acknowledged === true).
        // A record with no acknowledged field at all (written before that field existed) reads as
        // undefined !== true, the same as an explicit false — neither counts.
        if (Array.isArray(changed) && changed.length === 0 && e.payload["acknowledged"] === true) {
          acceptedAsIs++;
        }
        if (Array.isArray(changed) && changed.length > 0) {
          const artifactId = String(e.payload["artifactId"] ?? "");
          schemaEdits.push({
            key: reviewKey(e),
            artifactId,
            fields: changed
              .map((c) =>
                c != null && typeof c === "object" ? (c as Record<string, unknown>)["field"] : undefined,
              )
              .filter((f): f is string => typeof f === "string"),
          });
        }
        break;
      }
      case "component.schemaProposed": {
        const draft = e.payload["draft"];
        const componentType =
          draft != null && typeof draft === "object"
            ? (draft as Record<string, unknown>)["componentType"]
            : undefined;
        if (typeof componentType === "string" && componentType.length > 0) {
          proposedType.set(reviewKey(e), componentType);
        }
        break;
      }
      case "component.published":
        // Counts a promotion/reconcile audit backfill (payload.reconciled:true) the same as the original
        // synchronous record — the projection was published exactly once either way, so double-counting the
        // *fact* of publication is intentional here (only the audit log entry was delayed, not the publish itself).
        promotions.published++;
        break;
      case "component.withdrawn":
        promotions.withdrawn++;
        break;
      case "intent.fixated":
        fixations.fixated++;
        break;
      case "intent.unfixated":
        fixations.unfixated++;
        break;
      // intent.migrated (design.md #65) is intentionally ignored here: a migration-driven rewrite of a
      // fixation's pinnedSpec is neither a fresh fixation nor a removal, and has no counter of its own in
      // LineageSummary. It falls through to default like intent.observed (reserved, never fired).
      default:
        break;
    }
  }

  durations.sort((a, b) => a - b);
  reviewDurations.sort((a, b) => a - b);
  const denom = composed + fallbackTotal;
  const topN = Math.min(
    Math.max(Math.floor(opts.topIntentsLimit ?? TOP_INTENTS_DEFAULT), 1),
    TOP_INTENTS_MAX,
  );
  const topIntents: IntentUsage[] = [...intents.entries()]
    .map(([intentHash, v]) => ({ intentHash, canonical: v.canonical, count: v.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);

  for (const hash of fallbackHashes) {
    const canonical = canonicalOfHash.get(hash);
    const row = canonical != null ? l2Rows.get(canonical) : undefined;
    if (row != null) row.fallbacks++;
  }
  const l2ByIntent = [...l2Rows.values()].sort((a, b) => b.generated - a.generated).slice(0, topN);

  const editGroups = new Map<string, { count: number; fields: Map<string, number> }>();
  for (const edit of schemaEdits) {
    const key = proposedType.get(edit.key) ?? edit.artifactId;
    let group = editGroups.get(key);
    if (group == null) {
      group = { count: 0, fields: new Map() };
      editGroups.set(key, group);
    }
    group.count++;
    for (const field of edit.fields) group.fields.set(field, (group.fields.get(field) ?? 0) + 1);
  }
  const schemaEditsByComponent: SchemaEditGap[] = [...editGroups.entries()]
    .map(([key, g]) => ({
      key,
      count: g.count,
      topFields: [...g.fields.entries()]
        .map(([field, count]) => ({ field, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, SCHEMA_EDIT_TOP_FIELDS),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);

  return {
    events: scoped.length,
    composed,
    tiers,
    cache,
    fallback: {
      total: fallbackTotal,
      byKind,
      rate: denom > 0 ? fallbackTotal / denom : 0,
    },
    durationMs: {
      count: durations.length,
      p50: quantile(durations, 50),
      p95: quantile(durations, 95),
      p99: quantile(durations, 99),
      max: durations.length > 0 ? durations[durations.length - 1]! : null,
    },
    topIntents,
    promotions,
    review: {
      count: reviewDurations.length,
      durationMs: {
        p50: quantile(reviewDurations, 50),
        p95: quantile(reviewDurations, 95),
        max: reviewDurations.length > 0 ? reviewDurations[reviewDurations.length - 1]! : null,
      },
      acceptedAsIs,
    },
    fixations,
    usage: summarizeUsage(scoped, { bucket: "day" }),
    l2ByIntent,
    schemaEditsByComponent,
  };
}

/**
 * Folds the lineage stream into per-day, per-tenant metering rows (pure, read-only). Reads only
 * view.composed / view.fallback / intent.fixated / intent.unfixated; every other event type is ignored.
 */
export function summarizeUsage(
  events: readonly LineageEventRecord[],
  opts: SummarizeUsageOptions,
): UsageRow[] {
  // `opts.bucket` is "day" today (the field keeps the signature open for wider buckets).
  const rows = new Map<string, UsageRow>();
  const rowFor = (e: LineageEventRecord): UsageRow => {
    const day = e.ts.slice(0, 10);
    const tenant = e.tenant ?? "";
    const key = `${day}\u0000${tenant}`;
    let row = rows.get(key);
    if (row == null) {
      row = {
        day,
        tenant,
        composed: 0,
        cache: { hit: 0, miss: 0, bypass: 0, fixated: 0 },
        tiers: { L0: 0, L1: 0, L2: 0 },
        l2Generated: 0,
        fallbacks: 0,
        tokens: { input: 0, output: 0 },
        fixated: 0,
        unfixated: 0,
      };
      rows.set(key, row);
    }
    return row;
  };

  for (const e of events) {
    if (opts.tenant != null && e.tenant !== opts.tenant) continue;
    if (opts.since != null && e.ts < opts.since) continue;
    if (opts.until != null && e.ts > opts.until) continue;
    switch (e.type) {
      case "view.composed": {
        const row = rowFor(e);
        row.composed++;
        const tier = e.payload["tier"];
        if (tier === "L0" || tier === "L1" || tier === "L2") row.tiers[tier]++;
        const cacheKey = e.payload["cache"];
        if (cacheKey === "hit" || cacheKey === "miss" || cacheKey === "bypass" || cacheKey === "fixated") {
          row.cache[cacheKey]++;
        }
        if (tier === "L2" && (cacheKey === "miss" || cacheKey === "bypass")) row.l2Generated++;
        const decision = e.payload["decision"];
        const usage =
          decision != null && typeof decision === "object"
            ? (decision as Record<string, unknown>)["usage"]
            : undefined;
        if (usage != null && typeof usage === "object") {
          const u = usage as Record<string, unknown>;
          if (typeof u["inputTokens"] === "number" && Number.isFinite(u["inputTokens"])) {
            row.tokens.input += u["inputTokens"];
          }
          if (typeof u["outputTokens"] === "number" && Number.isFinite(u["outputTokens"])) {
            row.tokens.output += u["outputTokens"];
          }
        }
        break;
      }
      case "view.fallback":
        rowFor(e).fallbacks++;
        break;
      case "intent.fixated":
        rowFor(e).fixated++;
        break;
      case "intent.unfixated":
        rowFor(e).unfixated++;
        break;
      default:
        break;
    }
  }

  return [...rows.values()].sort((a, b) =>
    a.day !== b.day ? (a.day < b.day ? -1 : 1) : a.tenant < b.tenant ? -1 : a.tenant > b.tenant ? 1 : 0,
  );
}

/** Nearest-rank percentile of an ascending-sorted array (null if empty). */
function quantile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[idx]!;
}

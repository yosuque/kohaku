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
   * complete a review (the candidate is re-nominated later and measured again from that nomination). A
   * reviewed event with no preceding nomination in the window is ignored. Quantiles are nearest-rank like
   * durationMs. `acceptedAsIs` counts component.schemaEdited records whose `changed` is empty (the machine
   * suggestion was approved without any edit) — the ticket's "zero-edit approval" KPI.
   */
  review: {
    count: number;
    durationMs: { p50: number | null; p95: number | null; max: number | null };
    acceptedAsIs: number;
  };
  /** Fixation event counts (intent.fixated / intent.unfixated). */
  fixations: { fixated: number; unfixated: number };
}

/** Narrowing and shaping options for summarizeLineage. */
export interface SummarizeLineageOptions {
  /** Narrow by tenant (aggregate only records whose record.tenant matches). Older events without a recorded tenant are excluded as non-matching. */
  tenant?: string;
  /** Aggregate only events at or after this time (record.ts >= since). Expects canonical ISO8601 (the route normalizes before passing). */
  since?: string;
  /** Aggregate only events at or before this time (record.ts <= until). Expects canonical ISO8601. */
  until?: string;
  /** N for topIntents. Default 10, clamped to 1..50. */
  topIntentsLimit?: number;
}

const TOP_INTENTS_DEFAULT = 10;
const TOP_INTENTS_MAX = 50;

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

  let composed = 0;
  let fallbackTotal = 0;
  // (tenant, artifactId) -> ts of the latest nomination not yet closed by an approve/reject review.
  const openNominations = new Map<string, string>();
  const reviewDurations: number[] = [];
  let acceptedAsIs = 0;
  const reviewKey = (e: LineageEventRecord): string =>
    `${e.tenant ?? ""}\u0000${String(e.payload["artifactId"] ?? "")}`;

  for (const e of scoped) {
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
        break;
      }
      case "view.fallback": {
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
      case "component.nominated":
        promotions.nominated++;
        openNominations.set(reviewKey(e), e.ts);
        break;
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
        if (Array.isArray(changed) && changed.length === 0) acceptedAsIs++;
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
  };
}

/** Nearest-rank percentile of an ascending-sorted array (null if empty). */
function quantile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[idx]!;
}

import { type LineageEventRecord, matchesLineageFilter } from "@kohaku-ui/spec-core";

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
   * Catalog gap: the Intents that went to free-form L2 generation (view.composed of tier L2 with cache miss or
   * bypass), aggregated per `canonical` and ordered by `generated` descending, then `fallbacks` descending (top
   * N, N as for `topIntents`). `generated` counts the composes that actually generated an L2 Spec and succeeded:
   * a record whose `payload.fallback` has kind "generation" or no kind (the generation failed, or the budget
   * skipped L2, and a fallback Spec was served under the same tier / cache label) and a single-flight follower
   * (`decision.coalesced`, which rode on another request's generation) are not generations; a negotiation
   * downgrade (`payload.fallback.kind` "negotiation") is applied to a generated Spec, so it is one.
   * `fallbacks` counts every record carrying `payload.fallback`, negotiation included, read
   * from the view.composed record itself (not from `view.fallback`: the REST and the MCP profile both record a
   * `view.composed` and a `view.fallback` for the same compose, so counting both would double-count).
   * `intentHash` is the first one seen for that
   * canonical (a representative; the same canonical can recur with different params). A canonical with no
   * L2-labelled compose has no row.
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
 * (design.md #74). `l2Generated` counts the composes that actually generated an L2 Spec and succeeded:
 * view.composed events of tier L2 whose cache was miss or bypass, other than a record whose
 * `payload.fallback` has kind "generation" or no kind (a failed or budget-skipped generation keeps the L2 label
 * on its fallback Spec) and a single-flight follower (`decision.coalesced`). A negotiation downgrade
 * (`payload.fallback.kind` "negotiation") is applied to a Spec that was generated, so it still counts.
 * `fallbacks` counts view.composed records that carry `payload.fallback`, whatever their tier. It reads the
 * composed record rather than `view.fallback` because the REST and the MCP profile both record a `view.composed`
 * and a `view.fallback` for the same compose (SPEC.md, MCP profile recording points), so counting both would
 * double-count. `tokens` sums `view.composed`'s
 * `payload.decision.usage` (a single-flight follower carries no usage, so it never double-counts).
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
  /** view.composed records that carry `payload.fallback`. */
  fallbacks: number;
  tokens: { input: number; output: number };
  /**
   * intent.fixated records: how many times a fixation was created (an operation count, not the composes served
   * from a fixation: that is `cache.fixated`).
   */
  fixationsCreated: number;
  /** intent.unfixated records: how many times a fixation was removed (an operation count). */
  fixationsRemoved: number;
}

/** Options for summarizeUsage. */
export interface SummarizeUsageOptions {
  /** The bucket width. Only "day" (UTC) exists. */
  bucket: "day";
  /**
   * Aggregate only records whose record.tenant matches. Read like a StoragePort's `LineageFilter.tenant`
   * (`normalizeTenant`): the empty string means no filter, so it keeps every record, including the ones that
   * carry no tenant (an MCP host never resolves one, so its composes always land in the `tenant: ""` row).
   */
  tenant?: string;
  /** Aggregate only events at or after this time (record.ts >= since). */
  since?: string;
  /** Aggregate only events at or before this time (record.ts <= until). */
  until?: string;
}

/** Narrowing and shaping options for summarizeLineage. */
export interface SummarizeLineageOptions {
  /**
   * Narrow by tenant (aggregate only records whose record.tenant matches). Older events without a recorded
   * tenant are excluded as non-matching. The empty string means no filter (`normalizeTenant`, as in a
   * StoragePort's `LineageFilter`).
   */
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

/** A view.composed record that carries `payload.fallback`: a fallback Spec was served for it. */
function hasFallback(payload: Readonly<Record<string, unknown>>): boolean {
  return payload["fallback"] != null;
}

/**
 * A view.composed record whose `payload.fallback` marks a failed or budget-skipped *generation* (kind
 * "generation", or no kind at all): the L2 label stayed but no Spec was generated. A negotiation downgrade
 * (kind "negotiation", registry/negotiate.ts) is not one: it is applied to a Spec that was generated and
 * consumed its tokens, so that compose still counts as a generation.
 */
function isGenerationFallback(payload: Readonly<Record<string, unknown>>): boolean {
  const fallback = payload["fallback"];
  if (fallback == null) return false;
  const kind = typeof fallback === "object" ? (fallback as Record<string, unknown>)["kind"] : undefined;
  return kind === undefined || kind === "generation";
}

/** A view.composed record of a single-flight follower (`payload.decision.coalesced`): it rode on another generation. */
function isCoalesced(payload: Readonly<Record<string, unknown>>): boolean {
  const decision = payload["decision"];
  return (
    decision != null &&
    typeof decision === "object" &&
    (decision as Record<string, unknown>)["coalesced"] === true
  );
}

/**
 * Classifies a view.composed record's `payload.tier` / `payload.cache` against the known vocabularies
 * (`tier` / `cache` are undefined for anything else), and whether the record is an L2 generation attempt (tier
 * L2 whose cache was miss or bypass). `mode` keeps the two callers' existing reads apart: `"coerced"` (what
 * `summarizeLineage` does) reads each field as `String(value ?? "")`, `"raw"` (what `summarizeUsage` does)
 * compares the value as it is. The two only differ on a malformed payload (e.g. an array that stringifies to a
 * known name), and unifying them would change the result there.
 */
function classifyComposed(
  payload: Readonly<Record<string, unknown>>,
  mode: "coerced" | "raw",
): {
  tier: "L0" | "L1" | "L2" | undefined;
  cache: "hit" | "miss" | "bypass" | "fixated" | undefined;
  l2Attempt: boolean;
} {
  const tierValue: unknown = mode === "coerced" ? String(payload["tier"] ?? "") : payload["tier"];
  const cacheValue: unknown = mode === "coerced" ? String(payload["cache"] ?? "") : payload["cache"];
  const tier = tierValue === "L0" || tierValue === "L1" || tierValue === "L2" ? tierValue : undefined;
  const cache =
    cacheValue === "hit" || cacheValue === "miss" || cacheValue === "bypass" || cacheValue === "fixated"
      ? cacheValue
      : undefined;
  return { tier, cache, l2Attempt: tier === "L2" && (cache === "miss" || cache === "bypass") };
}

/** The `(tenant, artifactId)` key shared by the review-turnaround and schema-edit accumulators. */
function reviewKey(e: LineageEventRecord): string {
  return `${e.tenant ?? ""}\u0000${String(e.payload["artifactId"] ?? "")}`;
}

/**
 * Accumulator for `LineageSummary.review`: pairs each nomination with its closing approve/reject review, and
 * counts the schema edits accepted as-is.
 */
function createReviewTurnaround() {
  // (tenant, artifactId) -> ts of the latest nomination not yet closed by an approve/reject review.
  const openNominations = new Map<string, string>();
  const durations: number[] = [];
  let acceptedAsIs = 0;
  return {
    /** component.nominated */
    nominated(e: LineageEventRecord): void {
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
    },
    /** component.reviewed */
    reviewed(e: LineageEventRecord): void {
      const decision = e.payload["decision"];
      if (decision === "approve" || decision === "reject") {
        const key = reviewKey(e);
        const nominatedAt = openNominations.get(key);
        if (nominatedAt != null) {
          const delta = Date.parse(e.ts) - Date.parse(nominatedAt);
          if (Number.isFinite(delta) && delta >= 0) durations.push(delta);
          openNominations.delete(key);
        }
      }
    },
    /** component.schemaEdited */
    schemaEdited(e: LineageEventRecord): void {
      const changed = e.payload["changed"];
      // acceptedAsIs requires BOTH no edits AND an explicit acknowledgement (payload.acknowledged === true).
      // A record with no acknowledged field at all (written before that field existed) reads as
      // undefined !== true, the same as an explicit false — neither counts.
      if (Array.isArray(changed) && changed.length === 0 && e.payload["acknowledged"] === true) {
        acceptedAsIs++;
      }
    },
    result(): LineageSummary["review"] {
      durations.sort((a, b) => a - b);
      return {
        count: durations.length,
        durationMs: {
          p50: quantile(durations, 50),
          p95: quantile(durations, 95),
          max: durations.length > 0 ? durations[durations.length - 1]! : null,
        },
        acceptedAsIs,
      };
    },
  };
}

/** Accumulator for `LineageSummary.schemaEditsByComponent`: the reviewer's schema edits grouped by component. */
function createSchemaEditGaps() {
  // (tenant, artifactId) -> the final component type of the latest component.schemaProposed; and the edits
  // (non-empty `changed`) to group once that map is complete.
  const proposedType = new Map<string, string>();
  const edits: { key: string; artifactId: string; fields: string[] }[] = [];
  return {
    /** component.schemaProposed */
    proposed(e: LineageEventRecord): void {
      const draft = e.payload["draft"];
      const componentType =
        draft != null && typeof draft === "object"
          ? (draft as Record<string, unknown>)["componentType"]
          : undefined;
      if (typeof componentType === "string" && componentType.length > 0) {
        proposedType.set(reviewKey(e), componentType);
      }
    },
    /** component.schemaEdited */
    edited(e: LineageEventRecord): void {
      const changed = e.payload["changed"];
      if (Array.isArray(changed) && changed.length > 0) {
        const artifactId = String(e.payload["artifactId"] ?? "");
        edits.push({
          key: reviewKey(e),
          artifactId,
          fields: changed
            .map((c) =>
              c != null && typeof c === "object" ? (c as Record<string, unknown>)["field"] : undefined,
            )
            .filter((f): f is string => typeof f === "string"),
        });
      }
    },
    result(topN: number): SchemaEditGap[] {
      const editGroups = new Map<string, { count: number; fields: Map<string, number> }>();
      for (const edit of edits) {
        const key = proposedType.get(edit.key) ?? edit.artifactId;
        let group = editGroups.get(key);
        if (group == null) {
          group = { count: 0, fields: new Map() };
          editGroups.set(key, group);
        }
        group.count++;
        for (const field of edit.fields) group.fields.set(field, (group.fields.get(field) ?? 0) + 1);
      }
      return [...editGroups.entries()]
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
    },
  };
}

/** Accumulator for `LineageSummary.l2ByIntent` (catalog-gap input): the generations and fallbacks of the composes labelled tier L2. */
function createL2Gaps() {
  // canonical -> the L2 row.
  const rows = new Map<string, L2IntentGap>();
  return {
    /** A view.composed record that `classifyComposed` reports as an L2 generation attempt. */
    record(payload: Readonly<Record<string, unknown>>): void {
      const intentHash = payload["intentHash"];
      const canonical = String(payload["canonical"] ?? "");
      let row = rows.get(canonical);
      if (row == null) {
        row = {
          canonical,
          intentHash: typeof intentHash === "string" ? intentHash : "",
          generated: 0,
          fallbacks: 0,
        };
        rows.set(canonical, row);
      } else if (row.intentHash === "" && typeof intentHash === "string") {
        row.intentHash = intentHash;
      }
      if (hasFallback(payload)) row.fallbacks++;
      if (!isGenerationFallback(payload) && !isCoalesced(payload)) row.generated++;
    },
    result(topN: number): L2IntentGap[] {
      return [...rows.values()]
        .sort((a, b) => b.generated - a.generated || b.fallbacks - a.fallbacks)
        .slice(0, topN);
    },
  };
}

/** Folds the raw lineage event stream into an aggregate summary (pure, read-only). */
export function summarizeLineage(
  events: readonly LineageEventRecord[],
  opts: SummarizeLineageOptions = {},
): LineageSummary {
  const scoped = events.filter((e) =>
    matchesLineageFilter(e, { tenant: opts.tenant, since: opts.since, until: opts.until }),
  );

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
  const l2Gaps = createL2Gaps();
  const schemaEditGaps = createSchemaEditGaps();
  const reviewTurnaround = createReviewTurnaround();

  let composed = 0;
  let fallbackTotal = 0;

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
        const { tier, cache: cacheKind, l2Attempt } = classifyComposed(e.payload, "coerced");
        if (tier != null) tiers[tier]++;
        if (cacheKind != null) cache[cacheKind]++;
        else cache.other++;
        const d = e.payload["durationMs"];
        if (typeof d === "number" && Number.isFinite(d)) durations.push(d);
        const intentHash = e.payload["intentHash"];
        if (typeof intentHash === "string" && intentHash.length > 0) {
          const prev = intents.get(intentHash);
          if (prev != null) prev.count++;
          else intents.set(intentHash, { canonical: String(e.payload["canonical"] ?? ""), count: 1 });
        }
        if (l2Attempt) l2Gaps.record(e.payload);
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
        reviewTurnaround.nominated(e);
        break;
      case "component.schemaSuggested":
        promotions.schemaSuggested++;
        break;
      case "component.judged":
        promotions.judged++;
        break;
      case "component.reviewed":
        promotions.reviewed++;
        reviewTurnaround.reviewed(e);
        break;
      case "component.schemaEdited":
        promotions.schemaEdited++;
        reviewTurnaround.schemaEdited(e);
        schemaEditGaps.edited(e);
        break;
      case "component.schemaProposed":
        schemaEditGaps.proposed(e);
        break;
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
    review: reviewTurnaround.result(),
    fixations,
    usage: summarizeUsage(scoped, { bucket: "day" }),
    l2ByIntent: l2Gaps.result(topN),
    schemaEditsByComponent: schemaEditGaps.result(topN),
  };
}

/**
 * Folds the lineage stream into per-day, per-tenant metering rows (pure, read-only). Reads only
 * view.composed / intent.fixated / intent.unfixated; every other event type (view.fallback included: the
 * fallback count comes from view.composed's `payload.fallback`) is ignored.
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
        fixationsCreated: 0,
        fixationsRemoved: 0,
      };
      rows.set(key, row);
    }
    return row;
  };

  for (const e of events) {
    if (!matchesLineageFilter(e, { tenant: opts.tenant, since: opts.since, until: opts.until })) continue;
    switch (e.type) {
      case "view.composed": {
        const row = rowFor(e);
        row.composed++;
        const { tier, cache: cacheKind, l2Attempt } = classifyComposed(e.payload, "raw");
        if (tier != null) row.tiers[tier]++;
        if (cacheKind != null) row.cache[cacheKind]++;
        if (l2Attempt && !isGenerationFallback(e.payload) && !isCoalesced(e.payload)) {
          row.l2Generated++;
        }
        if (hasFallback(e.payload)) row.fallbacks++;
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
      case "intent.fixated":
        rowFor(e).fixationsCreated++;
        break;
      case "intent.unfixated":
        rowFor(e).fixationsRemoved++;
        break;
      default:
        break;
    }
  }

  return [...rows.values()].sort(compareUsageRows);
}

function compareUsageRows(a: UsageRow, b: UsageRow): number {
  return a.day !== b.day ? (a.day < b.day ? -1 : 1) : a.tenant < b.tenant ? -1 : a.tenant > b.tenant ? 1 : 0;
}

/**
 * Adds two row lists key by key (`day`, `tenant`): rows with the same key are summed field by field, the rest
 * are kept; the result is ordered like `summarizeUsage`'s. Neither input is modified. It makes the summary
 * foldable: `mergeUsageRows(summarizeUsage(pageA), summarizeUsage(pageB))` equals `summarizeUsage` of both pages
 * together, so an exporter can page through a whole log and keep only the (small) row list in memory.
 */
export function mergeUsageRows(a: readonly UsageRow[], b: readonly UsageRow[]): UsageRow[] {
  const merged = new Map<string, UsageRow>();
  for (const row of [...a, ...b]) {
    const key = `${row.day}\u0000${row.tenant}`;
    const into = merged.get(key);
    if (into == null) {
      merged.set(key, {
        ...row,
        cache: { ...row.cache },
        tiers: { ...row.tiers },
        tokens: { ...row.tokens },
      });
      continue;
    }
    into.composed += row.composed;
    for (const k of ["hit", "miss", "bypass", "fixated"] as const) into.cache[k] += row.cache[k];
    for (const k of ["L0", "L1", "L2"] as const) into.tiers[k] += row.tiers[k];
    into.l2Generated += row.l2Generated;
    into.fallbacks += row.fallbacks;
    into.tokens.input += row.tokens.input;
    into.tokens.output += row.tokens.output;
    into.fixationsCreated += row.fixationsCreated;
    into.fixationsRemoved += row.fixationsRemoved;
  }
  return [...merged.values()].sort(compareUsageRows);
}

/** Nearest-rank percentile of an ascending-sorted array (null if empty). */
function quantile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[idx]!;
}

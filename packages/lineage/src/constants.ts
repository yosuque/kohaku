/**
 * Scan windows for the lineage-event aggregations below. Each aggregation reads only the most recent N
 * matching events from `StoragePort.listLineage` rather than the full log, trading exhaustiveness for a
 * bounded read (a since-window or an aggregate query, e.g. a DB backend, is the future direction once this
 * trade-off stops being acceptable).
 */

/** Tail window for `component.generated` when scanning promotion candidates (promotion/candidate-store.ts). */
export const GENERATED_SCAN_WINDOW = 1000;

/**
 * Tail window for `component.used` when aggregating usage, both across all artifacts combined
 * (promotion/usage.ts's `index`) and per artifact (`forArtifact`). Beyond this window the two can diverge
 * (overall tail window vs per-artifact tail window) — a known constraint.
 */
export const USAGE_SCAN_WINDOW = 10_000;

/** Tail window for `component.nominated` when checking the idempotency guard before nominating (promotion/nomination.ts). */
export const NOMINATED_SCAN_WINDOW = 10_000;

/**
 * Tail window for `component.published` / `component.withdrawn` when `reconcile` (promotion/service.ts) checks
 * for an existing audit record before backfilling one. Fetched once per `reconcile()` call (across every
 * artifact/tenant combined) instead of once per published/withdrawn snapshot, avoiding the N+1 of a dedicated
 * `listLineage` round trip per candidate.
 */
export const RECONCILE_AUDIT_SCAN_WINDOW = 10_000;

/** Tail window for `view.composed` when aggregating fixation proposals (fixation/service.ts). */
export const FIXATION_PROPOSAL_SCAN_WINDOW = 5000;

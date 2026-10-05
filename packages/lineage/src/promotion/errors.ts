/**
 * The call sites `createPromotions`' `onError` hook may fire from, named for the observability hook:
 * - `promotion.publish.audit` / `promotion.unpublish.audit`: the fail-open `component.published` /
 *   `component.withdrawn` audit record at publish/unpublish time failed (handlePublish / handleUnpublish).
 * - `promotion.reconcile.audit`: reconcile's audit-event backfill (for either side) failed.
 * - `promotion.reconcile.projection`: reconcile skipped re-applying a published snapshot's projection because
 *   neither the snapshot itself nor `component.generated` could supply the required html (#9).
 * - `promotion.nominate.tenant`: `evaluateAndList` (tenant unspecified) skipped auto-nominating a candidate that
 *   belongs to a specific tenant, to avoid persisting a tenant-neutral state for it (#10; promotion/nomination.ts).
 * - `promotion.nominate.audit`: the fail-open `component.nominated` audit record (recorded after the status
 *   transition to `candidate` is already persisted) failed for one nominated candidate (promotion/nomination.ts).
 *   Unlike publish/unpublish's audit, there is currently no reconcile-style backfill for a missed
 *   `component.nominated` event, so the audit trail stays incomplete for that artifact until a manual fix.
 * - `promotion.suggest.schema`: the optional `suggestSchema` hook (schema extraction) threw or rejected for one
 *   newly nominated candidate; the candidate is nominated without a suggestion (promotion/nomination.ts).
 * - `promotion.suggest.audit`: the fail-open `component.schemaSuggested` audit record failed (nomination.ts).
 * - `promotion.approve.audit`: the fail-open `component.schemaEdited` audit record on the approve path failed.
 * - `storage.record.invalid`: a promotion-state record read back from `StoragePort.getPromotionState`
 *   (candidate-store.ts's `loadCandidate`) failed `@kohaku-ui/spec-core`'s `PromotionStateSchema` (a
 *   corrupted or hand-edited `promotions.json` entry). The reader treats it exactly
 *   like a real absence (the candidate falls back to status "in_use", the same default as no persisted state
 *   at all); shared with lineage's Fixations service, which uses the same discriminator string for the
 *   equivalent fixation-record check (fixation/service.ts's `FixationErrorEndpoint`).
 */
export type PromotionErrorEndpoint =
  | "promotion.publish.audit"
  | "promotion.unpublish.audit"
  | "promotion.reconcile.audit"
  | "promotion.reconcile.projection"
  | "promotion.nominate.tenant"
  | "promotion.nominate.audit"
  | "promotion.suggest.schema"
  | "promotion.suggest.audit"
  | "promotion.approve.audit"
  | "storage.record.invalid";

/** Context passed to `createPromotions`' `onError` hook alongside the causing error. */
export interface PromotionErrorContext {
  endpoint: PromotionErrorEndpoint;
  artifactId: string;
  tenant?: string;
}

/**
 * Fires opts.onError fire-and-forget, swallowing any synchronous throw from the hook itself (an
 * observation-only hook must never mask or replace the caller's own error/result). Deliberately local
 * (not imported from composer's fireObserverHook) because lineage does not depend on composer (dependency
 * direction). Exported so promotion/nomination.ts (the tenant-mismatch skip, #10) can share the same
 * fire-and-forget discipline rather than duplicating it.
 */
export function notifyPromotionError(
  onError: ((ctx: PromotionErrorContext, error: unknown) => void) | undefined,
  ctx: PromotionErrorContext,
  error: unknown,
): void {
  if (onError == null) return;
  try {
    onError(ctx, error);
  } catch {
    // Swallowed: an observability-only hook must not affect publish/reconcile's own control flow.
  }
}

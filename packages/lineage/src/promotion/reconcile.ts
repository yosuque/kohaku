import type { LineageEventRecord, PromotionState, StoragePort } from "@kohaku-ui/spec-core";
import { RECONCILE_AUDIT_SCAN_WINDOW } from "../constants.js";
import type { LineageEventType } from "../events.js";
import { notifyFailOpen } from "../fail-open.js";
import type { Lineage } from "../lineage.js";
import { tenantField } from "../tenant-scope.js";
import { createFailOpenAudit } from "./audit.js";
import type { BulkCandidateLoader, CandidateStore } from "./candidate-store.js";
import type { PromotionErrorContext } from "./errors.js";
import { mayHaveProjection, type PromotionStatus } from "./machine.js";
import {
  type PublishProjectionArgs,
  publishArgs,
  type UnpublishProjectionArgs,
  unpublishArgs,
} from "./projection.js";
import { usageIndexKey } from "./usage.js";

/** Summary returned by `reconcile()` (#11): how many published/withdrawn snapshots had their projection
 * re-applied, and how many were skipped because the data needed to rebuild the projection was unrecoverable
 * (reported individually via `onError({endpoint: "promotion.reconcile.projection"})`). */
export interface ReconcileSummary {
  published: number;
  withdrawn: number;
  skipped: number;
}

/** The shared inputs of one `reconcile` pass, built once before its per-snapshot loop. */
interface ReconcileContext {
  summary: ReconcileSummary;
  loader: BulkCandidateLoader;
  /** `(tenant, artifactId)` keys that already have a `component.published` event. */
  publishedAuditKeys: Set<string>;
  /** `(tenant, artifactId)` keys that already have a `component.withdrawn` event with `from: "published"`. */
  withdrawnFromPublishedAuditKeys: Set<string>;
}

/**
 * Projection-recovery step of the promotion pipeline, split out of createPromotions (a God-factory split,
 * mirroring createNomination). Owns `reconcile` and its per-snapshot helpers. It depends only on the storage,
 * the candidate store's `bulkLoader`, the lineage (for the fail-open audit backfill) and the product's
 * `onPublish` / `onUnpublish` / `onError` hooks, forwarded verbatim from createPromotions' own options (see
 * their docs there). It must not import service.ts (the projection argument builders live in projection.ts for
 * that reason).
 */
export function createReconciler(opts: {
  storage: StoragePort;
  lineage: Lineage;
  store: Pick<CandidateStore, "bulkLoader">;
  onPublish?: (args: PublishProjectionArgs) => Promise<void>;
  onUnpublish?: (args: UnpublishProjectionArgs) => Promise<void>;
  onError?: (ctx: PromotionErrorContext, error: unknown) => void;
}): {
  /** See `reconcile`'s own doc below. */
  reconcile(): Promise<ReconcileSummary>;
} {
  const { storage, store, onPublish, onUnpublish, onError } = opts;
  const auditFailOpen = createFailOpenAudit(opts.lineage, onError);

  /**
   * Builds the set of `(tenant, artifactId)` keys (see `usageIndexKey`) that already have a lineage audit event of
   * `type` (optionally narrowed by `predicate`), from a single tail-window read (RECONCILE_AUDIT_SCAN_WINDOW), so
   * reconcile's per-snapshot audit backfill check is a Set lookup rather than its own `listLineage` round trip.
   */
  async function auditKeySet(
    type: LineageEventType,
    predicate?: (event: LineageEventRecord) => boolean,
  ): Promise<Set<string>> {
    const events = await storage.listLineage({ type: [type], limit: RECONCILE_AUDIT_SCAN_WINDOW });
    return new Set(
      (predicate != null ? events.filter(predicate) : events).map((e) =>
        usageIndexKey(e.tenant, e.payload["artifactId"] as string),
      ),
    );
  }

  /**
   * reconcile's step for a `published` snapshot: re-checks the freshest status after the load, backfills a
   * missing `component.published` audit event, then re-applies onPublish from the rebuilt candidate (or skips and
   * reports when the projection cannot be rebuilt). See `reconcile`'s doc for the scan/load race and the
   * summary counting rules.
   */
  async function reconcilePublished(state: PromotionState, ctx: ReconcileContext): Promise<void> {
    const key = usageIndexKey(state.tenant, state.artifactId);
    const candidate = await ctx.loader.load(state.artifactId, state.tenant);
    // Re-check the freshest status right after the load (see this function's doc on the scan/load race): a
    // *real* candidate whose status has since moved off "published" is a stale scan entry, not a failure,
    // so skip it uncounted and without onError -- the withdrawn branch converges it (this reconcile or the
    // next). candidate == null is a different, pre-existing case (loadCandidate found no source data at
    // all) and falls through unchanged to the "unrecoverable" skip+onError path below.
    if (candidate != null && candidate.status !== "published") return;
    if (candidate?.draft != null && !ctx.publishedAuditKeys.has(key)) {
      await auditFailOpen({
        endpoint: "promotion.reconcile.audit",
        type: "component.published",
        payload: {
          artifactId: state.artifactId,
          componentType: candidate.draft.componentType,
          version: candidate.draft.version,
          intentName: candidate.draft.intentName,
          reconciled: true,
        },
        tenant: state.tenant,
        artifactId: state.artifactId,
      });
    }
    if (onPublish == null) return;
    // The projection cannot be reconstructed unless both draft (state, or the snapshot's own duplicate) and
    // html (snapshot duplicate or component.generated) are present. Anything unrecoverable due to a missing
    // audit log etc. is skipped (the snapshot remains, so it is retried on the next reconcile) and reported.
    if (candidate?.draft == null || candidate.html == null) {
      ctx.summary.skipped++;
      notifyFailOpen(
        onError,
        {
          endpoint: "promotion.reconcile.projection",
          artifactId: state.artifactId,
          ...tenantField(state.tenant),
        },
        new Error(
          candidate?.draft == null
            ? `cannot rebuild the published projection for artifact ${state.artifactId}: no schema draft is recorded`
            : `cannot rebuild the published projection for artifact ${state.artifactId}: no html is recorded (neither the snapshot nor component.generated has it)`,
        ),
      );
      return;
    }
    await onPublish(publishArgs(candidate, state.tenant));
    ctx.summary.published++;
  }

  /**
   * reconcile's step for a `withdrawn` snapshot, symmetric with `reconcilePublished`: re-apply the projection
   * removal for a withdrawal whose onUnpublish failed partway, after re-checking the freshest status and
   * backfilling a missing `component.withdrawn` (from:"published") audit event.
   */
  async function reconcileWithdrawn(state: PromotionState, ctx: ReconcileContext): Promise<void> {
    const key = usageIndexKey(state.tenant, state.artifactId);
    if (onUnpublish == null) return;
    const candidate = await ctx.loader.load(state.artifactId, state.tenant);
    // Re-check the freshest status for the same race as the published branch (see reconcile's own
    // doc): a *real* candidate that has since been re-published is a stale scan entry, not a failure, so it
    // is skipped uncounted and without onError rather than incorrectly unpublished -- the published branch
    // converges it instead. candidate == null is a different, pre-existing case (loadCandidate found no
    // source data at all) and falls through unchanged to the "no draft" skip right below.
    if (candidate != null && candidate.status !== "withdrawn") return;
    // A candidate with no persisted draft was never published (or its draft is unrecoverable), so there is
    // no projection to remove and it is skipped.
    if (candidate?.draft == null) return;
    // Backfill component.withdrawn for a withdrawn snapshot, symmetric with the published side: matched
    // by `from: "published"` so a pre-promotion withdraw's own (unrelated) withdrawn event does not suppress
    // this backfill.
    if (!ctx.withdrawnFromPublishedAuditKeys.has(key)) {
      await auditFailOpen({
        endpoint: "promotion.reconcile.audit",
        type: "component.withdrawn",
        payload: { artifactId: state.artifactId, from: "published", reconciled: true },
        tenant: state.tenant,
        artifactId: state.artifactId,
      });
    }
    await onUnpublish(unpublishArgs(candidate, state.tenant));
    ctx.summary.withdrawn++;
  }

  /**
   * Projection recovery from snapshot authority. Scans the published/withdrawn snapshots across all tenants —
   * every other status has no projection to converge, see `mayHaveProjection` — assembles each artifact's
   * complete candidate — since #9, `candidate.html` (and sha256/ref) come from the snapshot's own duplicated
   * copy when present, falling back to `component.generated` for older snapshots persisted before this change —
   * and idempotently re-applies onPublish. Called at startup (and callable on demand, e.g. host-rest's `POST
   * /promotions/reconcile`, #11), projections (catalog/Intent) left un-reflected by a mid-publish failure
   * converge from the snapshot. Symmetrically, re-applies onUnpublish for every withdrawn snapshot whose
   * candidate still has a persisted draft, converging a withdrawal whose projection removal failed partway.
   *
   * Race with a concurrent transition: the scan (`listPromotionStates`) and each candidate's `store.load` are
   * two separate reads with no lock held across them (host-rest's `POST /promotions/reconcile` route only takes
   * the tenant-neutral lock bucket, so a tenant-scoped approve/withdraw can run between the two). `store.load`
   * always re-reads `getPromotionState`, so right after it returns, the candidate's status is already the
   * freshest value on hand — trusting it is all the fix takes. Both branches below re-check that status
   * immediately after the load and skip (uncounted, without `onError`; this is a stale scan entry, not an
   * unrecoverable failure) when it no longer matches what the scan expected: the published branch will not
   * re-publish a projection for a candidate that has since been withdrawn, and the withdrawn branch will not
   * unpublish one that has since been re-published. The other branch's own pass (this reconcile or the next)
   * converges the skipped entry instead. Serializing the whole scan+load sequence against every per-tenant lock
   * bucket (two-phase locking) would close this window entirely; that is a structural follow-up, not implemented
   * here.
   *
   * Also backfills the audit event for either direction: publish's `component.published` record and unpublish's
   * `component.withdrawn` record are both fail-open (see handlePublish / handleUnpublish in service.ts), so a storage
   * hiccup there can leave a published/withdrawn snapshot with no matching audit event on the log. For every
   * published snapshot with a persisted draft, reconcile checks for an existing `component.published` event (by
   * artifactId + tenant) and, if none is found, records one with `reconciled: true` as the audit marker
   * (distinguishing it from the original synchronous record); symmetrically for a withdrawn snapshot and
   * `component.withdrawn` (matched by `from: "published"`, so a pre-promotion withdraw's own withdrawn event
   * does not satisfy this check). A second reconcile finds the backfilled event and does not duplicate it. Note
   * this means `reconciled:true` events are counted the same as any other event of that type by lineage's
   * analytics aggregation.
   *
   * Returns a summary (`ReconcileSummary`, #11) of how many published/withdrawn projections were re-applied and
   * how many snapshots were skipped because the data needed to rebuild the projection was unrecoverable (a
   * published snapshot with no draft and no html anywhere, reported individually via
   * `onError({endpoint: "promotion.reconcile.projection"})` — the snapshot itself is untouched either way, so it
   * is retried on the next reconcile). The race-driven skips described above are deliberately not counted here
   * (they are not failures).
   *
   * N+1 avoidance: before the loop, this builds the same bulk indexes `scanCandidatesWithTenant` /
   * `listByStatus` build once instead of once per candidate (`store.bulkLoader`: a usage index, and the latest
   * `component.generated` per `(tenant, artifactId)`, falling back to `loadCandidate`'s own per-artifact lookup
   * for anything outside `GENERATED_SCAN_WINDOW`), plus an
   * existing-audit-record index for both `component.published` and `component.withdrawn(from:"published")` (so
   * the per-candidate backfill check below is a Set lookup rather than its own `listLineage` round trip).
   */
  async function reconcile(): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = { published: 0, withdrawn: 0, skipped: 0 };
    if (onPublish == null && onUnpublish == null) return summary;
    // Scan snapshots across all tenants (listPromotionStates with tenant omitted returns all). Each state has .tenant.
    const states = await storage.listPromotionStates();
    const loader = await store.bulkLoader(undefined);
    const ctx: ReconcileContext = {
      summary,
      loader,
      publishedAuditKeys: await auditKeySet("component.published"),
      withdrawnFromPublishedAuditKeys: await auditKeySet(
        "component.withdrawn",
        (e) => e.payload["from"] === "published",
      ),
    };
    for (const state of states) {
      // Only published/withdrawn snapshots can have a projection to converge (see mayHaveProjection's doc).
      // state.status is PromotionState's storage-layer `string` (loosely typed at the StoragePort boundary);
      // cast to PromotionStatus the same way candidate-store.ts's loadCandidate already does for this field.
      if (!mayHaveProjection(state.status as PromotionStatus)) continue;
      // mayHaveProjection admits only "published" and "withdrawn", so anything not published is withdrawn.
      if (state.status === "published") await reconcilePublished(state, ctx);
      else await reconcileWithdrawn(state, ctx);
    }
    return summary;
  }

  return { reconcile };
}

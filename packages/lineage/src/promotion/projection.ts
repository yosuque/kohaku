import { tenantField } from "../tenant-scope.js";
import type { PromotionCandidate } from "./candidate.js";
import type { ComponentDraft } from "./machine.js";

/**
 * Projection-argument leaf of the promotion pipeline. `publishArgs` / `unpublishArgs` are shared by service.ts
 * (the publish / unpublish transitions) and reconcile.ts (projection recovery), so they live here instead of in
 * either of them: reconcile.ts must never import service.ts (no import cycle inside promotion/).
 */

/** The argument of `onPublish` (projection application): what `publishArgs` builds. */
export type PublishProjectionArgs = {
  artifactId: string;
  draft: ComponentDraft;
  html: string;
  request?: string;
  tenant?: string;
};

/** The argument of `onUnpublish` (projection removal): what `unpublishArgs` builds. */
export type UnpublishProjectionArgs = { artifactId: string; draft: ComponentDraft; tenant?: string };

/**
 * Builds the onPublish projection argument object (draft/html required, request/tenant included only when
 * non-null). Shared by `handlePublish` (the publish transition) and `reconcile` (projection recovery from
 * snapshot authority) so the two call sites cannot drift. Callers must only invoke this once candidate.draft
 * and candidate.html are confirmed non-null (handlePublish's guard; reconcile's `continue` guard).
 * Pure (no closure dependency on createPromotions' opts/store).
 */
export function publishArgs(candidate: PromotionCandidate, tenant?: string): PublishProjectionArgs {
  return {
    artifactId: candidate.artifactId,
    draft: candidate.draft!,
    html: candidate.html!,
    ...(candidate.request != null ? { request: candidate.request } : {}),
    ...tenantField(tenant),
  };
}

/**
 * Builds the onUnpublish projection-removal argument object (the pair of `publishArgs`). Shared by
 * `handleUnpublish` (the unpublish transition) and `reconcile` (projection-removal recovery from snapshot
 * authority) so the two call sites cannot drift. Callers must only invoke this once candidate.draft is
 * confirmed non-null (handleUnpublish's fail-fast guard; reconcile's `continue` guard).
 */
export function unpublishArgs(candidate: PromotionCandidate, tenant?: string): UnpublishProjectionArgs {
  return {
    artifactId: candidate.artifactId,
    draft: candidate.draft!,
    ...tenantField(tenant),
  };
}

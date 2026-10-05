import type { ActorKind, LineageEventType } from "../events.js";
import type { Lineage } from "../lineage.js";
import { tenantField } from "../tenant-scope.js";
import { notifyPromotionError, type PromotionErrorContext, type PromotionErrorEndpoint } from "./errors.js";

/**
 * Shared fail-open audit-record helper for the promotion pipeline (H7). Five call sites (handlePublish's
 * component.published, handleUnpublish's component.withdrawn, reconcile's published/withdrawn backfill in
 * service.ts, and nomination.ts's component.nominated) each record a lineage audit event whose own failure must
 * not block the surrounding transition/projection -- the audit record is reported via `onError` instead of
 * thrown. This is a verbatim extraction of that repeated try/catch: argument order, the payload/actor passed to
 * `lineage.record`, and the `onError` context shape are unchanged from the five original sites.
 */
export async function recordFailOpen(
  lineage: Pick<Lineage, "record">,
  onError: ((ctx: PromotionErrorContext, error: unknown) => void) | undefined,
  endpoint: PromotionErrorEndpoint,
  type: LineageEventType,
  payload: Record<string, unknown>,
  actor: ActorKind | undefined,
  scope: { tenant?: string; artifactId: string },
): Promise<void> {
  try {
    await lineage.record(type, payload, actor, scope.tenant);
  } catch (e) {
    notifyPromotionError(
      onError,
      { endpoint, artifactId: scope.artifactId, ...tenantField(scope.tenant) },
      e,
    );
  }
}

/**
 * Binds `recordFailOpen`'s two per-pipeline arguments (the lineage and the `onError` hook, identical at every
 * call site of one `createPromotions` / `createNomination` closure) once, so each call site only names what
 * differs. Same record-then-notify behavior as `recordFailOpen`, which it delegates to.
 */
export function createFailOpenAudit(
  lineage: Pick<Lineage, "record">,
  onError: ((ctx: PromotionErrorContext, error: unknown) => void) | undefined,
): (args: {
  endpoint: PromotionErrorEndpoint;
  type: LineageEventType;
  payload: Record<string, unknown>;
  actor?: ActorKind;
  tenant?: string;
  artifactId: string;
}) => Promise<void> {
  return ({ endpoint, type, payload, actor, tenant, artifactId }) =>
    recordFailOpen(lineage, onError, endpoint, type, payload, actor, { tenant, artifactId });
}

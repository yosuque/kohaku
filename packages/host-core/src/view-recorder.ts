import type { ComposeTrace } from "@kohaku-ui/composer";
import type { JsonObject, Surface, UISpec } from "@kohaku-ui/spec-core";
import { failOpen } from "./errors.js";

/**
 * Recording hooks for View Lineage (@kohaku-ui/lineage supplies the implementation; no recording if unset).
 * Shared by both host profiles (REST's KohakuHostDeps.recorder and the MCP profile's McpHostDeps.recorder) so
 * a single interface governs what "audit-recording symmetry between the two surfaces" means. Originally
 * defined in host-rest's types.ts; moved here so the MCP profile can depend on the same contract instead of
 * carrying only the narrower `onComposed` callback it used to have.
 */
export interface ViewRecorder {
  composed(args: {
    spec: UISpec;
    trace: ComposeTrace;
    surface: Surface;
    sessionId?: string;
    tenant?: string;
    /** Precomputed hash (shared with the done event so specHash is computed once per request). If passed, the recorder implementation does not re-hash the Spec. If unset, computed internally (backward compatible). */
    specHash?: string;
    structureHash?: string;
  }): Promise<void>;
  interacted(args: {
    intentHash: string;
    specHash?: string;
    componentId: string;
    on: string;
    payload: JsonObject;
    surface: Surface;
    sessionId?: string;
    tenant?: string;
  }): Promise<void>;
  rendered?(args: {
    specHash: string;
    surface: Surface;
    renderer: string;
    durationMs?: number;
    tenant?: string;
  }): Promise<void>;
  componentUsed?(args: {
    artifactId: string;
    surface: Surface;
    outcome: "ok" | "error";
    sessionId?: string;
    tenant?: string;
  }): Promise<void>;
  /**
   * Records a fallback (deterministic downgrade on L1/L2 generation failure / component downgrade via capability
   * negotiation). The judgment source is spec.provenance.fallback. No recording if unset.
   */
  fallback?(args: {
    spec: UISpec;
    reason: string;
    kind: "generation" | "negotiation";
    surface: Surface;
    sessionId?: string;
    tenant?: string;
    /** Precomputed hash. If passed, the recorder implementation does not re-hash the Spec. If unset, computed internally (backward compatible). */
    specHash?: string;
  }): Promise<void>;
}

/**
 * The cancelled-aware, fail-open "record the composed result" sequence shared by both host profiles (REST's
 * deliverComposed/finishStream and the MCP profile's composeAndAudit): a cancelled compose (the caller's
 * abort fired) is not a generation failure and observer.onError already received phase:"cancelled" from the
 * composer, so `record` is skipped entirely — a client disconnect/timeout must not inflate view.composed /
 * view.fallback counts. Otherwise `record` (the host's own composed -> fallback recording, in that order) runs
 * fail-open (host-core's failOpen): a recording failure must not take down an otherwise-successful delivery,
 * and is instead reported to `onError`. Caveat: this only protects `record`; `onError` itself must not throw
 * (a throwing `onError` is not caught here and would escape to the caller).
 */
export async function recordComposedResult(
  result: { spec: UISpec; trace: ComposeTrace },
  record: () => Promise<void>,
  onError: (e: unknown) => void | Promise<void>,
): Promise<void> {
  if (result.trace.cancelled === true) return;
  await failOpen(record, async (e) => {
    await onError(e);
  });
}

/**
 * Records view.fallback when the spec includes a fallback (deterministic downgrade on generation failure /
 * capability-negotiation downgrade). The judgment source is the spec, not the compose trace: negotiation
 * downgrade happens every time at finish even after a cache hit, so without looking at
 * spec.provenance.fallback the downgrade on the cache-hit path would be missed. A missing `kind` is treated as
 * "generation" (compatible with older records that predate the field).
 *
 * Shared by both host profiles (REST's recordFallbackIfAny and the MCP profile's composeAndAudit) so the
 * fallback-detection rule lives in exactly one place instead of two independently-drifting copies.
 */
export async function recordViewFallback(
  recorder: ViewRecorder | undefined,
  spec: UISpec,
  meta: { surface: Surface; sessionId?: string; tenant?: string; specHash?: string },
): Promise<void> {
  const fallback = spec.provenance.fallback;
  if (fallback == null) return;
  await recorder?.fallback?.({
    spec,
    reason: fallback.reason,
    kind: fallback.kind ?? "generation",
    surface: meta.surface,
    ...(meta.specHash != null ? { specHash: meta.specHash } : {}),
    ...(meta.sessionId != null ? { sessionId: meta.sessionId } : {}),
    ...(meta.tenant != null ? { tenant: meta.tenant } : {}),
  });
}

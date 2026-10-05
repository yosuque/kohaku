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
    /** The compose trace's correlation id (ComposeTrace.correlationId), so a devtool can find this
     * view.fallback event via the `/lineage?correlationId=` filter alongside the request's other events. */
    correlationId?: string;
  }): Promise<void>;
}

/**
 * The cancelled-aware, fail-open "record the composed result" sequence shared by both host profiles (REST's
 * deliverComposed/finishStream and the MCP profile's composeAndAudit): a cancelled compose (the caller's
 * abort fired) is not a generation failure and observer.onError already received phase:"cancelled" from the
 * composer, so `record` is skipped entirely — a client disconnect/timeout must not inflate view.composed /
 * view.fallback counts. Otherwise `record` (the host's own composed -> fallback recording, in that order --
 * `recordComposedAndFallback` below is that pair) runs
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
 * Both host profiles reach this through `recordComposedAndFallback` below (REST's deliverComposed/finishStream
 * and the MCP profile's composeAndAudit), so the fallback-detection rule lives in exactly one place instead
 * of two independently-drifting copies.
 */
export async function recordViewFallback(
  recorder: ViewRecorder | undefined,
  spec: UISpec,
  meta: {
    surface: Surface;
    sessionId?: string;
    tenant?: string;
    specHash?: string;
    /** Forwarded unchanged to ViewRecorder.fallback's own correlationId (see its doc comment). */
    correlationId?: string;
  },
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
    ...(meta.correlationId != null ? { correlationId: meta.correlationId } : {}),
  });
}

/**
 * The composed -> fallback recording pair both host profiles run inside `recordComposedResult`'s record
 * callback (REST's deliverComposed/finishStream, the MCP profile's composeAndAudit): `recorder.composed`
 * first, then `recordViewFallback` (a no-op unless the spec carries `provenance.fallback`), and nothing at all
 * when no `recorder` is wired. Order-neutral about where it sits in a host's delivery sequence and about
 * cancellation / fail-open handling, which stay with `recordComposedResult` and the caller.
 *
 * Optional `meta` keys (`specHash`, `sessionId`, `tenant`) are spread only when present, so the recorder sees
 * an absent key rather than an `undefined` one: REST passes all of them (a precomputed `specHash` plus its
 * session metadata), the MCP profile passes only `surface` (it computes no `specHash` and resolves no
 * session). The fallback record additionally carries the compose trace's `correlationId` when set.
 */
export async function recordComposedAndFallback(
  recorder: ViewRecorder | undefined,
  result: { spec: UISpec; trace: ComposeTrace },
  meta: { surface: Surface; specHash?: string; sessionId?: string; tenant?: string },
): Promise<void> {
  if (recorder == null) return;
  await recorder.composed({
    spec: result.spec,
    trace: result.trace,
    surface: meta.surface,
    ...(meta.specHash != null ? { specHash: meta.specHash } : {}),
    ...(meta.sessionId != null ? { sessionId: meta.sessionId } : {}),
    ...(meta.tenant != null ? { tenant: meta.tenant } : {}),
  });
  await recordViewFallback(recorder, result.spec, {
    surface: meta.surface,
    ...(meta.specHash != null ? { specHash: meta.specHash } : {}),
    ...(meta.sessionId != null ? { sessionId: meta.sessionId } : {}),
    ...(meta.tenant != null ? { tenant: meta.tenant } : {}),
    ...(result.trace.correlationId != null ? { correlationId: result.trace.correlationId } : {}),
  });
}

import type { Downgrade } from "@kohaku-ui/registry";
import type { CanonicalIntent, SemanticInput } from "@kohaku-ui/spec-core";

export interface ComposeAttempt {
  kind: "l1" | "l2";
  ok: boolean;
  issues?: string[];
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * W3C Trace Context (https://www.w3.org/TR/trace-context/), propagated by the caller (ComposeOptions.traceContext)
 * so an OTel span recorded for this compose (see @kohaku-ui/otel's createOtelComposeObserver) can be linked
 * as a child of the caller's own trace instead of always starting a fresh root trace. `traceparent` MUST
 * already be strictly W3C-formatted by the time it reaches here -- host-rest (the `traceparent` request
 * header) and host-mcp-apps (`_meta.traceparent`, MCP 2026-07-28 / SEP-414) both validate via host-core's
 * shared `parseTraceContext` before ever setting this field, so composer / observers treat a present value
 * as trustworthy without re-validating it. `tracestate` is carried through opaque (per the W3C spec).
 * Purely additive and opt-in: omitted entirely when the caller passes none.
 */
export interface TraceContext {
  traceparent: string;
  tracestate?: string;
}

/**
 * A record of the decisions at each stage of compose. Becomes input to lineage (view.composed) and evals.
 * Unlike the Spec body it is not cached, so it may include wall-clock information.
 */
export interface ComposeTrace {
  input: SemanticInput | { kind: "intent" };
  intent: CanonicalIntent;
  refs: string[];
  dataVersion: string;
  cacheKey: string;
  // "fixated" represents a fixation short-circuit (host-side short-circuit). The composer itself only sets
  // hit/miss/bypass; when the host short-circuits via fixation, it uses this value downstream (adding a value, so existing usage is backward compatible).
  cache: "hit" | "miss" | "bypass" | "fixated";
  tier: "L0" | "L1" | "L2";
  fallback?: { reason: string };
  attempts: ComposeAttempt[];
  downgrades?: Downgrade[];
  model?: string;
  durationMs: number;
  /** True when this rode along (coalesced) on the result of a preceding compose under single-flight. attempts is empty. */
  coalesced?: boolean;
  /** Sum of the attempts' usage (set only when at least one attempt has usage). */
  usage?: { inputTokens: number; outputTokens: number };
  /**
   * True when the delivered fallback Spec was caused by the caller's AbortSignal firing (a client
   * disconnect or timeout), not an actual generation failure. Hosts check this to skip recording
   * view.composed/view.fallback for the compose (a cancel must not inflate the fallback-rate analytics
   * the same way a real generation failure does). Never set on an "ok" tier result.
   */
  cancelled?: true;
  /**
   * The caller-supplied correlation id (ComposeOptions.correlationId), carried through unchanged so a
   * degraded/fallback delivery can be tied back to the triggering request (host-rest's X-Request-Id /
   * error.requestId, or an MCP tool call's JSON-RPC request id). Unset when the caller passed none — a
   * purely additive, opt-in field.
   */
  correlationId?: string;
  /**
   * The caller-supplied W3C trace context (ComposeOptions.traceContext), carried through unchanged (same
   * additive/opt-in contract as correlationId above). See TraceContext's doc comment.
   */
  traceContext?: TraceContext;
}

/** The invariant part of the trace (through intent normalization + reference resolution + cacheKey computation). Shared by both hit and miss. */
export type TraceBase = Pick<
  ComposeTrace,
  "input" | "intent" | "refs" | "dataVersion" | "cacheKey" | "correlationId" | "traceContext"
>;

/** The per-path trace fields on top of TraceBase (durationMs is derived from startedAt inside buildComposeTrace). */
type TraceFields = Pick<ComposeTrace, "cache" | "tier" | "attempts"> &
  Partial<Pick<ComposeTrace, "fallback" | "coalesced" | "model" | "usage" | "cancelled">>;

/**
 * Assembles a ComposeTrace from the shared base + the per-path fields. The single place that stamps
 * durationMs, shared by the cache-hit / L0 / L1-L2-fallback / follower paths.
 *
 * A dependency-free leaf (only TraceBase/TraceFields, both defined here): scope is typed structurally
 * rather than as `Pick<PreparedCompose, "traceBase" | "startedAt">` so this can be called from single-flight.ts
 * without a value-level import back into compose.ts (compose.ts and single-flight.ts both import this
 * function from here rather than from each other).
 */
export function buildComposeTrace(
  scope: { traceBase: TraceBase; startedAt: number },
  fields: TraceFields,
): ComposeTrace {
  return {
    ...scope.traceBase,
    cache: fields.cache,
    tier: fields.tier,
    ...(fields.fallback != null ? { fallback: fields.fallback } : {}),
    attempts: fields.attempts,
    ...(fields.coalesced === true ? { coalesced: true } : {}),
    ...(fields.model != null ? { model: fields.model } : {}),
    ...(fields.usage != null ? { usage: fields.usage } : {}),
    ...(fields.cancelled === true ? { cancelled: true as const } : {}),
    durationMs: Date.now() - scope.startedAt,
  };
}

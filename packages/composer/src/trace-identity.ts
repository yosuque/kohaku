import type { TraceBase, TraceContext } from "./trace.js";

/**
 * Picks the `input` / `intent` / `cacheKey` triple that every observer-context object for one compose
 * starts with (ComposeErrorContext, BudgetCheckErrorContext) out of the compose's TraceBase. Spread it
 * where the three keys used to be written out by hand (`cacheKey: key` etc.), so each site keeps its own
 * key order. Deliberately excludes correlationId/traceContext: a site that carries them appends
 * `traceIdentity(...)` itself, and one that does not (the budget-check error context) must not gain them.
 */
export function composeIdentityOf(traceBase: Pick<TraceBase, "input" | "intent" | "cacheKey">): {
  input: TraceBase["input"];
  intent: TraceBase["intent"];
  cacheKey: TraceBase["cacheKey"];
} {
  return { input: traceBase.input, intent: traceBase.intent, cacheKey: traceBase.cacheKey };
}

/**
 * Picks the correlationId/traceContext pair out of a source that carries them (ComposeOptions,
 * TraceBase, or a Pick of either) for spreading onto a trace or ComposeErrorContext object. Returns
 * only the keys whose values are non-null — never a key with an `undefined` value — matching the six
 * inline `...(x.correlationId != null ? { correlationId: x.correlationId } : {})`-shaped spreads this
 * replaces: an object with an `undefined`-valued key is not the same as the key being absent (it
 * serializes differently and changes Object.keys), so both correlationId and traceContext must stay
 * fully omitted, not merely set to undefined, when absent from the source.
 */
export function traceIdentity(src: { correlationId?: string; traceContext?: TraceContext }): {
  correlationId?: string;
  traceContext?: TraceContext;
} {
  return {
    ...(src.correlationId != null ? { correlationId: src.correlationId } : {}),
    ...(src.traceContext != null ? { traceContext: src.traceContext } : {}),
  };
}

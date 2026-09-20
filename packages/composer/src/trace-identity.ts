import type { TraceContext } from "./trace.js";

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

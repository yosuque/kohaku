import type { TraceContext } from "@kohaku-ui/composer";

/**
 * Strict W3C Trace Context `traceparent` format: `00-<32 lowercase hex trace-id>-<16 lowercase hex
 * parent-id>-<2 lowercase hex flags>`. Anything else (a future version byte, uppercase hex, wrong segment
 * lengths, garbage) is rejected rather than partially parsed. Also rejects an all-zero trace-id
 * (`00000000000000000000000000000000`) and an all-zero parent-id (`0000000000000000`) via the two negative
 * lookaheads below: the W3C spec (https://www.w3.org/TR/trace-context/#trace-id, #parent-id) defines both as
 * invalid, and OpenTelemetry's own `isSpanContextValid` already rejects them on the export side (see
 * @kohaku-ui/otel's `parentContextFrom`) -- accepting them here only to have them silently discarded there is
 * an inconsistency, not a feature.
 *
 * Shared by host-rest (reads the `traceparent` request header) and host-mcp-apps (reads
 * `_meta.traceparent`, per MCP 2026-07-28 / SEP-414's "Document OpenTelemetry trace context propagation
 * conventions for `_meta` keys") so both profiles validate identically.
 */
export const TRACEPARENT_RE =
  /^00-(?!00000000000000000000000000000000-)[0-9a-f]{32}-(?!0000000000000000-)[0-9a-f]{16}-[0-9a-f]{2}$/;

/**
 * Upper bound (characters) on `tracestate` before it is dropped rather than carried (W3C's own recommended
 * limit, https://www.w3.org/TR/trace-context/#tracestate-header-field-values). `tracestate` is passed
 * through to product observers (e.g. @kohaku-ui/otel's span parent-context restoration) largely unvalidated,
 * so an oversized value from an untrusted caller is capped here rather than forwarded as-is.
 */
const MAX_TRACESTATE_LENGTH = 512;

/**
 * Builds a `ComposeOptions.traceContext` value from a raw (untrusted) `traceparent` + optional
 * `tracestate` (e.g. an incoming HTTP header, or an MCP tool call's `_meta` field). Fail-open /
 * validating: returns undefined when `traceparent` is missing or not strictly W3C-formatted -- a
 * missing or malformed traceparent is never an error, kohaku simply proceeds without trace-context
 * propagation. `tracestate` is carried through opaque (per the W3C spec) whenever present as a non-empty
 * string of at most `MAX_TRACESTATE_LENGTH` characters; a longer value is dropped (the `traceparent` is
 * still carried) rather than forwarded unbounded to a downstream observer.
 */
export function parseTraceContext(traceparent: unknown, tracestate?: unknown): TraceContext | undefined {
  if (typeof traceparent !== "string" || !TRACEPARENT_RE.test(traceparent)) return undefined;
  const state =
    typeof tracestate === "string" && tracestate !== "" && tracestate.length <= MAX_TRACESTATE_LENGTH
      ? tracestate
      : undefined;
  return {
    traceparent,
    ...(state != null ? { tracestate: state } : {}),
  };
}

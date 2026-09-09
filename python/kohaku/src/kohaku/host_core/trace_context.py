"""W3C Trace Context (https://www.w3.org/TR/trace-context/) parsing. Port of
packages/host-core/src/trace-context.ts, shared by kohaku.host_rest (the `traceparent` request header) and
kohaku.host_mcp (`_meta.traceparent`, MCP 2026-07-28 / SEP-414's "Document OpenTelemetry trace context
propagation conventions for `_meta` keys") so both profiles validate identically.

**Canonical port note (parity gap, deliberately not papered over -- every other reference to this gap in
kohaku.host_core / kohaku.host_mcp / kohaku.host_rest is a one-line pointer back to this docstring; update
here, not there):** unlike the TS reference implementation, this Python port's ComposeOptions
(kohaku.composer) carries no `trace_context` parameter at all yet -- nor, in fact, a `correlation_id` one
either (kohaku.host_core.compose_with_fixation's signature has neither; TS's composeWithFixation has both).
There is therefore no sink to thread a parsed TraceContext into ComposeTrace / ComposeErrorContext the way
TS does. Adding that sink touches kohaku.composer AND kohaku.host_core.compose_with_fixation's signature --
a larger, separate change than a docstring fix. Until that lands, `parse_trace_context`'s result is used
only by each profile's own local failure-path observability hook (`HostErrorInfo.trace_context` /
`McpErrorInfo.trace_context`) -- still valuable (correlates a caller's own OTel trace with kohaku's own
error reports) even though it does not yet reach ComposeTrace. The OTel SDK itself (span creation / export)
is entirely out of scope for the Python port.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Strict W3C Trace Context `traceparent` format: `00-<32 lowercase hex trace-id>-<16 lowercase hex
# parent-id>-<2 lowercase hex flags>`. Anything else (a future version byte, uppercase hex, wrong segment
# lengths, garbage) is rejected rather than partially parsed. Also rejects an all-zero trace-id
# (32 zeros) and an all-zero parent-id (16 zeros) via the two negative lookaheads below: the W3C spec
# (https://www.w3.org/TR/trace-context/#trace-id, #parent-id) defines both as invalid, and OpenTelemetry's
# own span-context validity check already rejects them on the export side (see kohaku.otel's parent-context
# restoration) -- accepting them here only to have them silently discarded there is an inconsistency, not a
# feature.
TRACEPARENT_RE = re.compile(
    r"^00-(?!00000000000000000000000000000000-)[0-9a-f]{32}-(?!0000000000000000-)[0-9a-f]{16}-[0-9a-f]{2}$"
)

# Upper bound (characters) on `tracestate` before it is dropped rather than carried (W3C's own recommended
# limit, https://www.w3.org/TR/trace-context/#tracestate-header-field-values). `tracestate` is passed
# through to product observers largely unvalidated, so an oversized value from an untrusted caller is capped
# here rather than forwarded as-is.
_MAX_TRACESTATE_LENGTH = 512


@dataclass(frozen=True)
class TraceContext:
    """A caller-propagated W3C trace context. `traceparent` MUST already be strictly W3C-formatted by the
    time it reaches here -- `parse_trace_context` is the only constructor a profile should use."""

    traceparent: str
    tracestate: str | None = None


def parse_trace_context(traceparent: object, tracestate: object = None) -> TraceContext | None:
    """Builds a TraceContext from a raw (untrusted) traceparent + optional tracestate (e.g. an incoming
    HTTP header, or an MCP tool call's `_meta` field). Fail-open / validating: returns None when
    `traceparent` is missing or not strictly W3C-formatted -- a missing or malformed traceparent is never an
    error, kohaku simply proceeds without trace-context propagation. `tracestate` is carried through opaque
    (per the W3C spec) whenever present as a non-empty string of at most `_MAX_TRACESTATE_LENGTH` characters;
    a longer value is dropped (the `traceparent` is still carried) rather than forwarded unbounded to a
    downstream observer."""
    if not isinstance(traceparent, str) or not TRACEPARENT_RE.match(traceparent):
        return None
    state = (
        tracestate
        if isinstance(tracestate, str) and tracestate != "" and len(tracestate) <= _MAX_TRACESTATE_LENGTH
        else None
    )
    return TraceContext(traceparent=traceparent, tracestate=state)

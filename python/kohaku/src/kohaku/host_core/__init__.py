"""kohaku.host_core — framework-free shared host core (port of packages/host-core).

Consumed by kohaku.host_rest and kohaku.host_mcp as thin adapters — the same relationship
packages/renderer-core has with renderer-react / renderer-wc in the TS reference implementation: a single
source of truth for the fixation (L1->L0) delivery + staleness self-healing sequence, capability issuance for
a composed Spec, and fail-open observability-hook helpers.
"""

from .capability import (
    DEFAULT_CAPABILITY_TTL_SECONDS,
    WriteScopeDroppedError,
    issue_capability_for_spec,
)
from .errors import fail_open, is_typed_host_error, notify_hook
from .fixation import (
    ComposeFixationContext,
    FixationDeliveryHost,
    FixationSelfHealApi,
    FixationSelfHealKind,
    FixationTarget,
    compose_with_fixation,
    resolve_fixated_result,
    settle_fixation,
)
from .trace_context import TRACEPARENT_RE, TraceContext, parse_trace_context

__all__ = [
    "DEFAULT_CAPABILITY_TTL_SECONDS",
    "TRACEPARENT_RE",
    "ComposeFixationContext",
    "FixationDeliveryHost",
    "FixationSelfHealApi",
    "FixationSelfHealKind",
    "FixationTarget",
    "TraceContext",
    "WriteScopeDroppedError",
    "compose_with_fixation",
    "fail_open",
    "is_typed_host_error",
    "issue_capability_for_spec",
    "notify_hook",
    "parse_trace_context",
    "resolve_fixated_result",
    "settle_fixation",
]

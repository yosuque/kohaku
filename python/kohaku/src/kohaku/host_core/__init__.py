"""kohaku.host_core — framework-free shared host core (port of packages/host-core).

Consumed by kohaku.host_rest and kohaku.host_mcp as thin adapters — the same relationship
packages/renderer-core has with renderer-react / renderer-wc in the TS reference implementation: a single
source of truth for the fixation (L1->L0) delivery + staleness self-healing sequence, capability issuance for
a composed Spec, and fail-open observability-hook helpers.
"""

from .action_effects import (
    ActionEffectsHook,
    ActionEffectsResponse,
    ActionEffectsResult,
    apply_action_effects,
)
from .allowed_actions import AllowedActions, create_allowed_actions
from .binding_ref import (
    InvokableRef,
    ParsedInvokableRef,
    ParsedInvokableRefOk,
    ParsedInvokableRefSourceMismatch,
    parse_invokable_ref,
)
from .capability import (
    DEFAULT_CAPABILITY_TTL_SECONDS,
    WriteScopeDroppedError,
    issue_capability_for_spec,
)
from .errors import (
    ConsoleErrorReporter,
    ConsoleErrorReporterOptions,
    create_console_error_reporter,
    fail_open,
    format_error_chain,
    is_typed_host_error,
    notify_hook,
)
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
from .intent import (
    IntentSource,
    IntentSourceGui,
    IntentSourceIntent,
    IntentSourceNl,
    ResolvedIntent,
    resolve_intent,
)
from .keyed_mutex import get_lock
from .rate_limit import (
    MemoryRateLimitStore,
    RateLimiter,
    RateLimiterErrorInfo,
    RateLimiterTakeParams,
    create_memory_rate_limit_store,
    create_rate_limiter,
)
from .trace_context import TRACEPARENT_RE, TraceContext, parse_trace_context
from .view_recorder import record_view_fallback

__all__ = [
    "DEFAULT_CAPABILITY_TTL_SECONDS",
    "TRACEPARENT_RE",
    "ActionEffectsHook",
    "ActionEffectsResponse",
    "ActionEffectsResult",
    "AllowedActions",
    "ComposeFixationContext",
    "ConsoleErrorReporter",
    "ConsoleErrorReporterOptions",
    "FixationDeliveryHost",
    "FixationSelfHealApi",
    "FixationSelfHealKind",
    "FixationTarget",
    "IntentSource",
    "IntentSourceGui",
    "IntentSourceIntent",
    "IntentSourceNl",
    "InvokableRef",
    "MemoryRateLimitStore",
    "ParsedInvokableRef",
    "ParsedInvokableRefOk",
    "ParsedInvokableRefSourceMismatch",
    "RateLimiter",
    "RateLimiterErrorInfo",
    "RateLimiterTakeParams",
    "ResolvedIntent",
    "TraceContext",
    "WriteScopeDroppedError",
    "apply_action_effects",
    "compose_with_fixation",
    "create_allowed_actions",
    "create_console_error_reporter",
    "create_memory_rate_limit_store",
    "create_rate_limiter",
    "fail_open",
    "format_error_chain",
    "get_lock",
    "is_typed_host_error",
    "issue_capability_for_spec",
    "notify_hook",
    "parse_invokable_ref",
    "parse_trace_context",
    "record_view_fallback",
    "resolve_fixated_result",
    "resolve_intent",
    "settle_fixation",
]

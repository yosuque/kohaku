"""kohaku.host_core — framework-free shared host core (port of packages/host-core).

Consumed by kohaku.host_rest and kohaku.host_mcp as thin adapters — the same relationship
packages/renderer-core has with renderer-react / renderer-wc in the TS reference implementation: a single
source of truth for the fixation (L1->L0) delivery + staleness self-healing sequence, capability issuance for
a composed Spec, and fail-open observability-hook helpers.
"""

from .action_audit import ActionAuditRecorder
from .action_effects import (
    ActionEffectsHook,
    ActionEffectsResponse,
    ActionEffectsResult,
    apply_action_effects,
)
from .action_gate import (
    ActionGate,
    ActionGateAllow,
    ActionGateApprovalRequired,
    ActionGateDenied,
    ActionGateInvalid,
    ActionGateRequest,
    ActionGateResult,
    create_action_gate,
)
from .action_manifest import ActionManifest, ActionManifestEntry, build_action_manifest
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
from .catalog_impact import (
    CatalogDeprecatedUsageEntry,
    CatalogDeprecatedUsageFixation,
    CatalogDeprecatedUsagePromotion,
    CatalogFixationIssue,
    CatalogImpactReport,
    CatalogOriginKitMismatch,
    CatalogPublishedPromotionIssue,
    analyze_catalog_impact,
)
from .catalog_migration import (
    CatalogMigrationApplyBlocked,
    CatalogMigrationApplyResult,
    CatalogMigrationBlocked,
    CatalogMigrationFixationReplacer,
    CatalogMigrationPlan,
    CatalogMigrationRewrite,
    CatalogMigrationStep,
    apply_catalog_migration,
    plan_catalog_migration,
    verify_catalog_migration_plan,
)
from .daily_token_ledger import DailyTokenLedger, create_daily_token_ledger
from .errors import (
    ConsoleErrorReporter,
    ConsoleErrorReporterOptions,
    create_console_error_reporter,
    fail_open,
    format_error_chain,
    is_typed_host_error,
    notify_hook,
    notify_hook_nowait,
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
from .operation_index import OperationIndex, OperationIndexEntry, create_operation_index
from .policy import (
    ParsedPolicy,
    PolicyAppliedEvent,
    PolicyRateLimiter,
    PolicyRateLimiterTakeParams,
    PolicyRuntime,
    RateLimitedInfo,
    create_policy_runtime,
    parse_policy,
)
from .policy_node import load_policy_file
from .rate_limit import (
    DEFAULT_MAX_MEMORY_ENTRIES,
    DEFAULT_RATE_LIMIT_TIMEOUT_MS,
    MemoryRateLimitStore,
    RateLimiter,
    RateLimiterErrorInfo,
    RateLimiterTakeParams,
    create_memory_rate_limit_store,
    create_rate_limiter,
)
from .serialize import to_jsonable
from .trace_context import TRACEPARENT_RE, TraceContext, parse_trace_context
from .view_recorder import record_view_fallback

__all__ = [
    "DEFAULT_CAPABILITY_TTL_SECONDS",
    "DEFAULT_MAX_MEMORY_ENTRIES",
    "DEFAULT_RATE_LIMIT_TIMEOUT_MS",
    "TRACEPARENT_RE",
    "ActionAuditRecorder",
    "ActionEffectsHook",
    "ActionEffectsResponse",
    "ActionEffectsResult",
    "ActionGate",
    "ActionGateAllow",
    "ActionGateApprovalRequired",
    "ActionGateDenied",
    "ActionGateInvalid",
    "ActionGateRequest",
    "ActionGateResult",
    "ActionManifest",
    "ActionManifestEntry",
    "AllowedActions",
    "CatalogDeprecatedUsageEntry",
    "CatalogDeprecatedUsageFixation",
    "CatalogDeprecatedUsagePromotion",
    "CatalogFixationIssue",
    "CatalogImpactReport",
    "CatalogMigrationApplyBlocked",
    "CatalogMigrationApplyResult",
    "CatalogMigrationBlocked",
    "CatalogMigrationFixationReplacer",
    "CatalogMigrationPlan",
    "CatalogMigrationRewrite",
    "CatalogMigrationStep",
    "CatalogOriginKitMismatch",
    "CatalogPublishedPromotionIssue",
    "ComposeFixationContext",
    "ConsoleErrorReporter",
    "ConsoleErrorReporterOptions",
    "DailyTokenLedger",
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
    "OperationIndex",
    "OperationIndexEntry",
    "ParsedInvokableRef",
    "ParsedInvokableRefOk",
    "ParsedInvokableRefSourceMismatch",
    "ParsedPolicy",
    "PolicyAppliedEvent",
    "PolicyRateLimiter",
    "PolicyRateLimiterTakeParams",
    "PolicyRuntime",
    "RateLimitedInfo",
    "RateLimiter",
    "RateLimiterErrorInfo",
    "RateLimiterTakeParams",
    "ResolvedIntent",
    "TraceContext",
    "WriteScopeDroppedError",
    "analyze_catalog_impact",
    "apply_action_effects",
    "apply_catalog_migration",
    "build_action_manifest",
    "compose_with_fixation",
    "create_action_gate",
    "create_allowed_actions",
    "create_console_error_reporter",
    "create_daily_token_ledger",
    "create_memory_rate_limit_store",
    "create_operation_index",
    "create_policy_runtime",
    "create_rate_limiter",
    "fail_open",
    "format_error_chain",
    "get_lock",
    "is_typed_host_error",
    "issue_capability_for_spec",
    "load_policy_file",
    "notify_hook",
    "notify_hook_nowait",
    "parse_invokable_ref",
    "parse_policy",
    "parse_trace_context",
    "plan_catalog_migration",
    "record_view_fallback",
    "resolve_fixated_result",
    "resolve_intent",
    "settle_fixation",
    "to_jsonable",
    "verify_catalog_migration_plan",
]

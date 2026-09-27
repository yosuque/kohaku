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
from .trace_context import TRACEPARENT_RE, TraceContext, parse_trace_context
from .view_recorder import record_view_fallback

__all__ = [
    "DEFAULT_CAPABILITY_TTL_SECONDS",
    "TRACEPARENT_RE",
    "ActionEffectsHook",
    "ActionEffectsResponse",
    "ActionEffectsResult",
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
    "FixationDeliveryHost",
    "FixationSelfHealApi",
    "FixationSelfHealKind",
    "FixationTarget",
    "IntentSource",
    "IntentSourceGui",
    "IntentSourceIntent",
    "IntentSourceNl",
    "InvokableRef",
    "ParsedInvokableRef",
    "ParsedInvokableRefOk",
    "ParsedInvokableRefSourceMismatch",
    "ResolvedIntent",
    "TraceContext",
    "WriteScopeDroppedError",
    "analyze_catalog_impact",
    "apply_action_effects",
    "apply_catalog_migration",
    "compose_with_fixation",
    "create_allowed_actions",
    "create_console_error_reporter",
    "fail_open",
    "format_error_chain",
    "get_lock",
    "is_typed_host_error",
    "issue_capability_for_spec",
    "notify_hook",
    "parse_invokable_ref",
    "parse_trace_context",
    "plan_catalog_migration",
    "record_view_fallback",
    "resolve_fixated_result",
    "resolve_intent",
    "settle_fixation",
    "verify_catalog_migration_plan",
]

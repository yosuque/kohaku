"""KohakuHostDeps and the governance-surface structural types (equivalent to KohakuHostDeps in packages/host-rest/src/routes.ts).

host-rest does not depend on lineage (the same design as TS). Promotions, Fixations, usage analytics
(summarize_lineage), and recording (ViewRecorder) are received via Protocols (structural subtypes), and concrete
implementations are injected by the product side (wiring). The Protocol method names / arguments follow the existing
Python implementation's (kohaku.lineage) snake_case style, so the return values of `create_promotions` /
`create_fixations` / `create_view_recorder` structurally conform as-is.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

from kohaku.composer import ComposeContext
from kohaku.host_core import AllowedActions, TraceContext
from kohaku.spec import (
    AuthzPort,
    DomainPort,
    FixationRecord,
    JsonObject,
    LineageEventRecord,
    Principal,
    SessionContext,
    Surface,
    UISpec,
)

from .governance_policy import GovernanceOperation

if TYPE_CHECKING:
    # starlette is a "rest" extra. Type annotations are stringified (from __future__), so they are not imported at runtime.
    from starlette.requests import Request


class ViewRecorderProtocol(Protocol):
    """View Lineage recording hooks (kohaku.lineage's ViewRecorder structurally conforms)."""

    async def composed(
        self,
        *,
        spec: UISpec,
        trace: Any,
        surface: Surface,
        session_id: str | None = ...,
        tenant: str | None = ...,
        spec_hash: str | None = ...,
        structure_hash: str | None = ...,
    ) -> None: ...

    async def interacted(
        self,
        *,
        intent_hash: str,
        component_id: str,
        on: str,
        payload: JsonObject,
        surface: Surface,
        session_id: str | None = ...,
        tenant: str | None = ...,
    ) -> None: ...

    async def rendered(
        self,
        *,
        spec_hash: str,
        surface: Surface,
        renderer: str,
        duration_ms: float | None = ...,
        tenant: str | None = ...,
    ) -> None: ...

    async def component_used(
        self,
        *,
        artifact_id: str,
        surface: Surface,
        outcome: str = ...,
        session_id: str | None = ...,
        tenant: str | None = ...,
    ) -> None: ...

    async def fallback(
        self,
        *,
        spec: UISpec,
        reason: str,
        kind: str,
        surface: Surface,
        session_id: str | None = ...,
        tenant: str | None = ...,
    ) -> None: ...


class PromotionsApi(Protocol):
    """Promotion pipeline management plane (kohaku.lineage's Promotions structurally conforms).

    In TS's PromotionsApi, list / listByStatus / get are optional, but Python's reference implementation (Promotions)
    provides all methods, so this Protocol requires the full surface (an intentional difference). The 501 for the
    unwired case (deps.promotions is None) is preserved.
    """

    async def list_candidates(self, *, tenant: str | None = ...) -> Any: ...
    async def list_by_status(self, status: Any, *, tenant: str | None = ...) -> Any: ...
    async def get(self, artifact_id: str, tenant: str | None = ...) -> Any: ...
    async def evaluate_and_list(self, *, tenant: str | None = ...) -> Any: ...
    async def act(
        self, artifact_id: str, action: Any, actor: Principal, tenant: str | None = ...
    ) -> Any: ...
    async def approve(
        self, artifact_id: str, draft: Any, reviewer: Principal, tenant: str | None = ...
    ) -> Any: ...
    async def reject(
        self, artifact_id: str, reviewer: Principal, tenant: str | None = ...
    ) -> Any: ...
    async def withdraw(
        self,
        artifact_id: str,
        actor: Principal,
        reason: str | None = ...,
        tenant: str | None = ...,
    ) -> Any: ...
    async def reconcile(self) -> Any: ...
    """Projection recovery from snapshot authority (#11), scanning across every tenant (no tenant argument —
    it is not a per-tenant operation). Used by POST /promotions/reconcile, an operator escape hatch to force
    convergence on demand (the same recovery kohaku.lineage's Promotions already runs at startup)."""


class FixationsApi(Protocol):
    """Fixation (L1->L0) management plane (kohaku.lineage's Fixations structurally conforms)."""

    async def proposals(self, *, tenant: str | None = ...) -> Any: ...
    async def list_fixations(self, *, tenant: str | None = ...) -> Any: ...
    async def fixate(
        self, *, pinned_spec: UISpec, approver: Principal, tenant: str | None = ...
    ) -> Any: ...
    async def unfixate(
        self, intent_hash: str, approver: Principal, tenant: str | None = ...
    ) -> None: ...
    async def invalidate(
        self,
        intent_hash: str,
        reason: str,
        detail: str | None = ...,
        tenant: str | None = ...,
        guard: dict[str, Any] | None = ...,
    ) -> None: ...
    async def refresh_fingerprint(
        self, intent_hash: str, catalog_fingerprint: str, tenant: str | None = ...
    ) -> None: ...


# Usage analytics aggregator (kohaku.lineage's summarize_lineage structurally conforms).
# The 2nd argument (aggregation options) receives an AnalyticsWindow, but is typed as Any to stay lineage-independent.
LineageSummarizer = Callable[[list[LineageEventRecord], Any], object]


@dataclass(frozen=True)
class AnalyticsWindow:
    """The aggregation window passed to summarize_lineage (structurally compatible with SummarizeLineageOptions)."""

    tenant: str | None = None
    since: str | None = None
    until: str | None = None
    topIntentsLimit: int | None = None


@dataclass(frozen=True)
class ActionEffects:
    """Side-effect declaration for a write (/binding/action). Returned after domain.invoke."""

    invalidates: list[str] | None = None
    refVersions: dict[str, str] | None = None


@dataclass(frozen=True)
class HostErrorInfo:
    """Information passed to the failure-path observability hook (on_error)."""

    endpoint: str
    request_id: str
    error: BaseException | object
    trace_context: TraceContext | None = None
    """The request's W3C trace context (the `traceparent` / `tracestate` request headers), when present and
    well-formed -- see kohaku.host_rest._routes.shared.trace_context_of. Populated only by the compose-path
    call sites (mirroring kohaku.host_mcp's McpErrorInfo.trace_context); every other call site keeps
    reporting None, unchanged from before this field existed."""


# Request -> Principal resolution (product responsibility). Can return either sync or async.
AuthHook = Callable[["Request"], "Awaitable[Principal | None] | Principal | None"]
# Request -> tenant resolution (product responsibility). Can return either sync or async.
TenantHook = Callable[["Request"], "Awaitable[str | None] | str | None"]
# Authorization hook for the governance/audit plane. false -> 403 CAPABILITY_DENIED.
AuthorizeGovernanceHook = Callable[
    [Principal, GovernanceOperation, "str | None"], "Awaitable[bool] | bool"
]
# Write side-effect declaration (optional). Called after domain.invoke.
ActionEffectsHook = Callable[[str, JsonObject, object], Awaitable[ActionEffects]]
# Failure-path observability hook. throw / reject are swallowed (observation only).
OnErrorHook = Callable[[HostErrorInfo], "Awaitable[None] | None"]
# Fixation short-circuit (L1->L0). Looked up before compose.
FixationLookupHook = Callable[[str, SessionContext], Awaitable["FixationRecord | None"]]
# Delivery-admission gate applied to a fixation found via fixation_lookup, before it is checked for
# staleness (kohaku.host_core's FixationDeliveryHost.admit). Sync or async.
FixationAdmitHook = Callable[["FixationRecord", SessionContext], "Awaitable[bool] | bool"]
# Per-request correlation id override (ops; product responsibility). Sync only (mirrors TS's requestId?: (c) => string).
RequestIdHook = Callable[["Request"], str]


@dataclass
class KohakuHostDeps:
    """The full set of host dependencies for the Kohaku Protocol REST profile (equivalent to TS's KohakuHostDeps).

    compose (generation context) + domain + authz are required. The governance surface (recorder / promotions /
    fixations / analytics_summarizer) is optional; when unwired the relevant route is 501 or runs degraded.
    """

    compose: ComposeContext
    domain: DomainPort
    authz: AuthzPort
    query_source: str
    """The permitted query:// source (e.g. "sales"). Resolving any other reference is rejected with SOURCE_MISMATCH."""
    auth: AuthHook | None = None
    """Principal extraction (product responsibility). When omitted, a demo anonymous principal."""
    tenant: TenantHook | None = None
    """Request -> tenant resolution. When omitted, no tenant (equivalent to single-tenant)."""
    request_id: RequestIdHook | None = None
    """Per-request correlation id resolution override (ops). Resolved once per request and reused for the
    `X-Request-Id` response header, every error envelope's `requestId`, and the `on_error` hook. When omitted,
    the default is: the inbound `x-request-id` request header when present and well-formed (trimmed, at most
    128 characters, printable ASCII only), otherwise a freshly generated uuid4."""
    capability_ttl_seconds: int | None = None
    max_body_bytes: int | None = None
    """Overrides the request-body size cap (bytes) applied by BodyLimitASGIMiddleware (ops; product
    responsibility). Default when omitted: 1 MiB (see _routes.shared.DEFAULT_MAX_BODY_BYTES; equivalent to
    TS's DEFAULT_MAX_BODY_BYTES in packages/host-rest/src/routes.ts). A product that already layers its own
    body-size limit in front of the mount point can leave this at the default — the two checks simply stack —
    or raise/lower it here to match."""
    fixation_lookup: FixationLookupHook | None = None
    """L1->L0 fixation short-circuit (looked up before compose; resolved per-tenant via the 2nd-argument
    SessionContext). Prefer keeping this a plain read and expressing any delivery gate (e.g. "serve pinned
    Specs to EN sessions only") via `fixation_admit` instead of filtering inside this callback — the same
    gate function can then be shared verbatim with the MCP profile's `McpHostDeps.fixation_admit`."""
    fixation_admit: FixationAdmitHook | None = None
    """Delivery-admission gate consulted, when set, after a fixation is found via `fixation_lookup` and
    before it is checked for staleness (kohaku.host_core's `FixationDeliveryHost.admit`). Lets a product
    express a "serve this fixation only to the right session" policy once, shared with the MCP profile's
    `fixation_admit`, instead of duplicating the check inside each profile's own `fixation_lookup`."""
    recorder: ViewRecorderProtocol | None = None
    promotions: PromotionsApi | None = None
    fixations: FixationsApi | None = None
    analytics_summarizer: LineageSummarizer | None = None
    """Usage analytics aggregator. When unwired, GET /analytics/summary is 501 NOT_IMPLEMENTED."""
    action_effects: ActionEffectsHook | None = None
    """Write side-effect declaration (optional). When unspecified, the response is only {result} = fully backward compatible."""
    on_error: OnErrorHook | None = None
    """Failure-path observability hook. When unwired, silent (no call is made); a requestId is issued and
    placed on the error envelope / X-Request-Id header regardless of whether this hook is wired (ops)."""
    authorize_governance: AuthorizeGovernanceHook | None = None
    """Governance/audit plane authorization hook. When unwired, allowed without authorization by default (backward compatible)."""
    _allowed_actions_fn: AllowedActions | None = field(default=None, init=False, repr=False, compare=False)
    """Memoized `AllowedActions` closure (host_core's `create_allowed_actions`, write-scope hardening; see
    _routes.shared.allowed_actions). Not part of the public constructor — built lazily on first capability
    issuance, one per `KohakuHostDeps` instance (list_operations is async and must not be re-awaited on every
    compose)."""

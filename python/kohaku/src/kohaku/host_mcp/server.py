"""The Kohaku Protocol MCP Apps profile (SEP-1865) body.

Port of packages/host-mcp-apps/src/server.ts. TS's McpServer.registerTool / registerResource are consolidated in
Python's mcp SDK into one handler each of the low-level Server's list_tools / call_tool / list_resources /
read_resource (tools are dispatched by name). Because CallToolResult can carry structuredContent and _meta directly,
the same wire shape as TS (co-embedded initial data, both _meta forms) can be reproduced.

- kohaku_compose (model-visible): NL -> the same Composition Service -> Spec + text fallback
- kohaku_resolve_binding / kohaku_event (app-only): callable only from the iframe.
  Bulk data does not pass through the model's context (the reference-passing principle is upheld on the MCP surface too).
- ui://kohaku/renderer.html: the shared renderer at text/html;profile=mcp-app
"""

from __future__ import annotations

import asyncio
import inspect
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol, cast

from kohaku.composer import (
    ComposeContext,
    ComposeResult,
    ComposeTrace,
)
from kohaku.data_binding import (
    assert_known_reserved_params,
    split_reserved_params,
)
from kohaku.host_core import (
    ComposeFixationContext,
    FixationDeliveryHost,
    FixationSelfHealApi,
    TraceContext,
    is_typed_host_error,
    parse_trace_context,
)
from kohaku.host_core import WriteScopeDroppedError as _WriteScopeDroppedError
from kohaku.host_core import compose_with_fixation as _host_core_compose_with_fixation
from kohaku.host_core import fail_open as _host_core_fail_open
from kohaku.host_core import issue_capability_for_spec as _host_core_issue_capability_for_spec
from kohaku.host_core import notify_hook as _host_core_notify_hook
from kohaku.spec import (
    AuthzPort,
    DomainPort,
    FixationRecord,
    GuiAction,
    IntentInput,
    InvocationContext,
    JsonObject,
    NLQuery,
    Principal,
    SessionContext,
    TabularData,
    UISpec,
    VerifyRequest,
    canonical_stringify,
    enumerate_bind_variants,
    finalize_intent,
    parse_query_ref,
)

from .fallback import spec_to_text
from .intent_tools import IntentToolDef
from .meta import (
    CAPABILITY_META_KEY,
    INITIAL_DATA_META_KEY,
    RENDERER_RESOURCE_URI,
    RESOURCE_MIME_TYPE,
    resource_ui_meta,
    tool_ui_meta,
)
from .snapshot import inject_snapshot

if TYPE_CHECKING:
    from mcp.server.lowlevel import Server
    from mcp.shared.context import RequestContext

_MCP_MISSING_MESSAGE = (
    "MCP host functionality requires the mcp SDK. Please run `pip install 'kohaku-ui[mcp]'`."
)

# Cumulative size budget (JSON characters) for the initial data co-embedded in the tool result's `_meta`.
# Claude-family hosts spill tool results over about 150k characters to the sandbox side and the widget does not
# hydrate, so cut off at 100k characters, leaving room for the structured Spec + text fallback.
INITIAL_DATA_BUDGET_CHARS = 100_000

# Per-ref timeout (seconds; same value as TS PRERESOLVE_TIMEOUT_MS = 2000) for initial-data preresolution.
# So a slow / unresponsive ref does not block the compose response, a timeout is treated as skip (that ref is not
# co-embedded), the same as the existing per-ref fail-open.
PRERESOLVE_TIMEOUT_S = 2.0

# Bounded concurrency (ops; mirrors TS PRERESOLVE_CONCURRENCY) for _preresolve_initial_data's ref resolution.
# Refs are resolved concurrently (up to this many in flight at once) rather than serially, so one slow-but-not-
# hung DomainPort call no longer holds up the others; the budget below is still applied afterward in the fixed
# initial-then-secondary order, so which refs end up embedded on overflow does not depend on completion order.
PRERESOLVE_CONCURRENCY = 8

# Overall wall-clock deadline (seconds; ops; mirrors TS PRERESOLVE_TOTAL_TIMEOUT_MS) for the whole
# _preresolve_initial_data call, on top of the per-ref timeout above. With up to 256 bind variants across many
# components, even healthy-but-slow resolutions can push total latency well past what a tool caller will wait
# for. Once this elapses, no further refs are started, and any still-in-flight resolution's eventual result
# (success or failure) is discarded rather than embedded — reported through the same per-ref fail-open on_error
# path as an ordinary per-ref failure, with a message identifying it as a deadline discard.
PRERESOLVE_TOTAL_TIMEOUT_S = 10.0

_ANONYMOUS = Principal(id="mcp-user", roles=["user"])

# Upper bound (canonical-JSON, UTF-8 bytes) on a `${prefix}_action` payload. Full argument-shape validation via
# OperationDescriptor.paramsSchema is a follow-up (no JSON Schema validator is wired into this repo yet) — this
# is a coarse defense-in-depth cap against an oversized write, not a shape check. Matches TS's
# MAX_ACTION_PAYLOAD_BYTES (packages/host-mcp-apps/src/server.ts).
MAX_ACTION_PAYLOAD_BYTES = 64 * 1024

# Upper bound on a JsonObject's nesting depth (the object itself = depth 1). Mirrors
# packages/spec-core/src/schema/json.ts's JsonObjectSchema depth cap (also mirrored locally by
# kohaku.host_rest.bodies' own MAX_JSON_OBJECT_DEPTH / _json_depth_ok — duplicated here rather than imported,
# since host_rest and host_mcp are independent siblings in the import-linter layer contract, same rationale as
# this module's local ViewRecorderProtocol). Guards the recursive canonical-JSON serialization (intent-hash
# computation) and lineage persistence downstream of `kohaku_event`'s `payload` / `intent.params` and
# `kohaku_action`'s `payload` against a pathologically deep but otherwise well-formed payload. On TS, the
# same-named fields are validated by JsonObjectSchema at the SDK's own input-schema layer, before the handler
# ever runs; the Python mcp SDK's tool schemas are JSON Schema hints only (no runtime validator wired in), so
# this is enforced inside each handler instead.
MAX_JSON_OBJECT_DEPTH = 32


def _json_depth_ok(value: Any, limit: int = MAX_JSON_OBJECT_DEPTH, depth: int = 1) -> bool:
    """True while `value`'s nesting stays within `limit` (the object/array itself = depth 1). Only descending
    into a dict/list counts toward depth — a scalar leaf never does, since it cannot nest any further. Mirrors
    spec-core/schema/json.ts's exceedsMaxJsonDepth (inverted: True = not exceeded) and
    kohaku.host_rest.bodies._json_depth_ok (structurally identical; see MAX_JSON_OBJECT_DEPTH's doc comment
    above for why this module carries its own copy)."""
    if isinstance(value, dict):
        if depth > limit:
            return False
        return all(_json_depth_ok(v, limit, depth + 1) for v in value.values())
    if isinstance(value, list):
        if depth > limit:
            return False
        return all(_json_depth_ok(v, limit, depth + 1) for v in value)
    return True

# The client-visible message for an untyped tool failure (an exception _safe_tool catches that no explicit
# _tool_error(...) call inside the tool body already produced). Port of TS host-mcp-apps'
# TOOL_INTERNAL_ERROR_MESSAGE (server.ts).
_TOOL_INTERNAL_ERROR_MESSAGE = "internal error; see the observability hook (on_error) for details"

# MCP 2026-07-28 (SEP-2549): freshness/cacheability hint attached to tools/list and resources/list results
# (CacheableResult.ttlMs / cacheScope). Matches TS host-mcp-apps' equivalent values.
_LIST_RESULT_TTL_MS = 60_000
_LIST_RESULT_CACHE_SCOPE = "private"

# Shared optional `locale` input for every UI-producing tool (compose / render_snapshot / intent
# tools / event). The calling LLM sets it to the user's language so the composed UI (fixed-spec
# titles, generated labels, L2 widget text) comes out localized — it maps onto the compose
# session's SessionContext.locale, the same wire knob the REST profile carries as session.locale.
# The name `locale` is reserved: intent params must not declare it (same shape as TS LOCALE_INPUT).
_LOCALE_PROPERTY: dict[str, Any] = {
    "type": "string",
    "description": (
        'Language tag of the user\'s environment (e.g. "ja" for Japanese, "en" for English). '
        "Set it to the language the user is conversing in; all user-visible text of the composed UI "
        "follows it. Omit for English."
    ),
}


def _mcp_session(locale: str | None, principal: Principal | None = None) -> SessionContext:
    """The compose session for one MCP tool call ("mcp-app" surface + the caller-provided locale)."""
    return SessionContext(surface="mcp-app", locale=locale, principal=principal)


def _mcp_request_context() -> RequestContext[Any, Any, Any] | None:
    """Returns the mcp SDK's request-scoped context object (`mcp.server.lowlevel.server.request_ctx`), which
    the SDK populates for the lifetime of this request's async call chain (Server._handle_request sets it
    before invoking the registered handler and resets it in a `finally`) — safe to read from any
    `await`-connected function called while handling one tool call, and concurrent requests each see their own
    copy (contextvars semantics). Returns None when there is no live request context (e.g. a handler invoked
    directly, as this port's own tests do).

    Extracted out of `_mcp_request_meta` (below) so `_principal_of` can hand the full context object to
    `McpHostDeps.resolve_principal` — mirroring TS's `ServerContext` argument to `resolvePrincipal` — rather
    than only the narrower `(request_id, meta)` pair that function itself needs.
    """
    try:
        from mcp.server.lowlevel.server import request_ctx

        return request_ctx.get()
    except LookupError:
        return None


def _mcp_request_meta() -> tuple[object | None, object | None]:
    """Returns (request_id, meta) off the mcp SDK's request-scoped context (see `_mcp_request_context`).
    Returns (None, None) when there is no live request context."""
    ctx = _mcp_request_context()
    if ctx is None:
        return None, None
    return ctx.request_id, ctx.meta


def _correlation_id_from_request_context() -> str | None:
    """The per-call correlation id: always the JSON-RPC request id of this tool call, never derived from
    `_meta.traceparent`. Mirrors TS host-mcp-apps' `requestContextOf().requestId` (used directly as the
    correlation id there too, after the removal of the former `correlationIdOf` helper — see that module's
    history). A W3C trace-id is shared by an entire trace, so deriving the correlation id from it would give
    every tool call in one conversation the SAME id, making it impossible to tell which call a reported
    failure belongs to; the JSON-RPC request id is unique per call. Trace correlation (linking this call's
    OTel span to the caller's own trace) flows separately, only through `_trace_context_from_request_context`
    below / McpErrorInfo.trace_context. Port note: see kohaku.host_core.trace_context's module docstring for
    why this has no ComposeOptions sink yet, so this id is used only for this profile's own failure-path
    observability hook (McpErrorInfo.correlation_id below). Fail-open: None when there is no live request
    context.
    """
    request_id, _meta = _mcp_request_meta()
    return str(request_id) if request_id is not None else None


def _trace_context_from_request_context() -> TraceContext | None:
    """The `_meta.traceparent` (+ `_meta.tracestate`, when present) as a TraceContext (kohaku.host_core's
    shared parse_trace_context, also used by kohaku.host_rest's `traceparent` request-header counterpart).
    Same parity-gap pointer as `_correlation_id_from_request_context` above (see
    kohaku.host_core.trace_context's module docstring): used only for this profile's own failure-path
    observability hook (McpErrorInfo.trace_context). Fail-open: None on a missing/malformed traceparent, or
    no live request context."""
    _request_id, meta = _mcp_request_meta()
    if meta is None:
        return None
    return parse_trace_context(getattr(meta, "traceparent", None), getattr(meta, "tracestate", None))


def _with_locale_input(input_schema: dict[str, Any], tool_name: str) -> dict[str, Any]:
    """Return a copy of an intent tool's inputSchema with the shared `locale` property injected.

    Rejects a catalog intent that declares a param named `locale` (the reserved name would be
    silently shadowed) — deterministic, same style as the tool-name collision check.
    """
    properties = cast(dict[str, Any], input_schema.get("properties", {}))
    if "locale" in properties:
        raise ValueError(
            f'Intent tool "{tool_name}" declares a param named "locale", '
            "which is reserved for the shared language input"
        )
    return {**input_schema, "properties": {**properties, "locale": _LOCALE_PROPERTY}}


def _locale_of(args: JsonObject) -> str | None:
    """Read the shared `locale` argument (permissive like REST: any non-string is ignored)."""
    locale = args.get("locale")
    return locale if isinstance(locale, str) else None


# ---------------------------------------------------------------------------
# Dependency / option types
# ---------------------------------------------------------------------------


# The fixation self-healing surface: an alias of kohaku.host_core.FixationSelfHealApi (also aliased by
# the REST profile's FixationsApi), which kohaku.lineage's Fixations satisfies as-is. The MCP surface is
# single-tenant (surface="mcp-app" / no tenant), so `tenant` is never passed (the tenant/lock asymmetry with the
# REST surface is intentional). The invalidate TOCTOU guard (`ifCatalogFingerprint`) is threaded through just
# like the REST surface (kohaku.host_core.settle_fixation), so a fixation that was re-approved after the stale
# check is not deleted by mistake.
McpFixationsApi = FixationSelfHealApi


class ViewRecorderProtocol(Protocol):
    """View Lineage recording hooks for the MCP profile, symmetric with the REST profile's
    ViewRecorderProtocol (kohaku.host_rest.deps) and TS's shared `@kohaku-ui/host-core` ViewRecorder.
    kohaku.lineage's ViewRecorder conforms structurally as-is.

    Defined locally rather than imported from kohaku.host_rest: the two host profiles are independent
    siblings in the Python layer contract (pyproject.toml's `[tool.importlinter]` layers list
    `host_rest | host_mcp | evals` at the same level, forbidding mutual imports), so this profile
    carries its own structural copy instead of depending on the REST package. Only the 3 methods this
    profile actually records (`composed` / `interacted` / `fallback`) are declared — `rendered` /
    `component_used` are REST-only (telemetry has no MCP surface).
    """

    async def composed(
        self,
        *,
        spec: UISpec,
        trace: Any,
        surface: str,
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
        surface: str,
        session_id: str | None = ...,
        tenant: str | None = ...,
    ) -> None: ...

    async def fallback(
        self,
        *,
        spec: UISpec,
        reason: str,
        kind: str,
        surface: str,
        session_id: str | None = ...,
        tenant: str | None = ...,
    ) -> None: ...


@dataclass(frozen=True)
class McpErrorInfo:
    """Information passed to the failure-path observability hook (same shape as REST's onError; the MCP surface has no requestId)."""

    endpoint: str
    error: BaseException
    correlation_id: str | None = None
    """The per-call JSON-RPC request id (see _correlation_id_from_request_context's doc comment — never a
    trace-id derived from `_meta.traceparent`; that would collapse every tool call in one trace onto the same
    id). Populated only for failures reported from _safe_tool's except branch (every tool handler routes
    through it); other report sites in this module (fixation self-heal, initial-data preresolution, etc.)
    still pass None, unchanged from before this field existed."""
    trace_context: TraceContext | None = None
    """The same `_meta.traceparent` (+ `_meta.tracestate`) as a TraceContext (see
    _trace_context_from_request_context's doc comment for the same parity-gap caveat as correlation_id
    above). Populated the same way and at the same call site as correlation_id."""


@dataclass(frozen=True)
class ActionEffects:
    """Side-effect declaration for a write (action). Same-shaped return value as the REST surface's salesActionEffects."""

    invalidates: list[str] | None = None
    refVersions: dict[str, str] | None = None


@dataclass(frozen=True)
class McpHostDeps:
    """The full set of MCP host wiring dependencies (same shape as TS McpHostDeps)."""

    compose: ComposeContext
    domain: DomainPort
    authz: AuthzPort
    query_source: str
    principal: Principal | None = None
    """The environment principal used when `resolve_principal` is unwired (also the fallback for a call whose
    `resolve_principal` returns before ever being consulted — see that field's doc comment for the full
    fallback order). Suitable for stdio (one process per user). **Must not be trusted as-is on a shared
    Streamable HTTP deployment**: `create_server()` builds a single `Server` shared by every session/connection
    (see `sales_api.mcp_http`, which calls it once), so a single `principal` here is the same identity for
    every caller — wire `resolve_principal` instead to resolve the caller's actual identity per tool call."""
    resolve_principal: (
        Callable[[RequestContext[Any, Any, Any] | None], Principal | Awaitable[Principal]] | None
    ) = None
    """Resolves the principal for a single tool call (from that call's mcp SDK `RequestContext` — see
    `_mcp_request_context`'s doc comment — or `None` when no live request context exists). Called once per
    tool call, inside the tool handler itself — before any of the following, all of which see the resolved
    result: `_issue_capability` (the principal the compose-issued capability is bound to),
    `SessionContext.principal` (read by `SemanticPort.normalize` / `ComposeContext.policyFor` / the fixation
    lookup, the same way `SessionContext.locale` already is), the initial-data preresolution's `domain.invoke`
    calls (a plain read — no capability is verified there), and the `verdict.principal or principal` fallback
    `_handle_resolve_binding` / `_handle_action` use when the AuthzPort's `verify` does not itself return a
    principal. May be sync or async (`inspect.isawaitable` decides whether to await the return value).

    Fallback order: `resolve_principal(ctx)` -> `deps.principal` -> the built-in anonymous principal. **A raise
    from `resolve_principal` is fail-closed**: the tool call returns a structured tool error (`isError`) and the
    failure is reported to `on_error` — it never silently falls back to `deps.principal` or anonymous, since
    doing so would let an identity-resolution failure quietly downgrade every subsequent call on this shared
    server to a shared/anonymous identity.

    Required for a shared Streamable HTTP deployment (`sales_api.mcp_http`, which builds one `Server` shared by
    every session) — see `principal`'s doc comment above for why a single static `principal` is unsafe there.
    When unwired, every call runs as `principal` or the built-in anonymous principal, unchanged from before
    this field existed."""
    fixation_lookup: Callable[[str, SessionContext], Awaitable[FixationRecord | None]] | None = None
    """Fixation lookup (intentHash, session -> FixationRecord | None). The session (surface
    "mcp-app" + the caller-provided locale) is passed so products can gate delivery — e.g. serve
    pinned Specs to EN sessions only, mirroring the REST surface's language gate (FixationRecord
    carries no language)."""
    recorder: ViewRecorderProtocol | None = None
    """View Lineage recording, symmetric with the REST profile's KohakuHostDeps.recorder: `composed` /
    `fallback` are recorded around every compose-family tool call, and `interacted` is recorded by
    _handle_event before recomposing (matching the REST surface's /events, which records `interacted`
    before `composed`/`fallback`). When both `recorder` and the legacy `on_composed` are wired,
    `recorder` takes priority (on_composed is not also called)."""
    on_composed: Callable[[UISpec, ComposeTrace], Awaitable[None]] | None = None
    """Deprecated: superseded by `recorder`, which additionally records `interacted` and `fallback`
    (symmetric with the REST profile). Kept for backward compatibility: still called when `recorder` is
    unwired. Failures are fail-open (they do not drag down UI delivery) and reported to on_error."""
    fixations: McpFixationsApi | None = None
    """The self-healing surface for fixation staleness detection. When unwired, stale -> only the normal compose fallback."""
    on_error: Callable[[McpErrorInfo], Awaitable[None] | None] | None = None
    """Failure-path observability hook. Silent when unwired. Hook throws are swallowed (observation only)."""
    action_effects: Callable[[str, JsonObject, object], Awaitable[ActionEffects]] | None = None
    """Write side-effect declaration (optional). When unspecified, the response is only `{result}` (backward compatible)."""


async def _principal_of(deps: McpHostDeps, fallback_principal: Principal) -> Principal:
    """Resolves the principal for one tool call — see `McpHostDeps.resolve_principal`'s doc comment for the
    full fallback order and rationale. A raise from `deps.resolve_principal` is deliberately NOT caught here:
    it propagates out of the `await _principal_of(...)` call inside each handler's `_safe_tool`-wrapped body,
    so `_safe_tool`'s own except branch turns it into a structured tool error (isError) and reports it to
    on_error — fail-closed, never silently downgraded to `fallback_principal` or anonymous.
    """
    if deps.resolve_principal is None:
        return fallback_principal
    result = deps.resolve_principal(_mcp_request_context())
    if inspect.isawaitable(result):
        result = await result
    return result


@dataclass(frozen=True)
class AttachOptions:
    """attach options (same shape as TS AttachOptions)."""

    renderer_html: str | Callable[[], Awaitable[str]]
    """The shared renderer bundle (the same rendering code as the Web = strategy A pixel parity)."""
    intent_tools: list[IntentToolDef] | None = None
    tool_prefix: str | None = None
    snapshot_writer: Callable[[str, str], Awaitable[str]] | None = None
    """The save hook for self-contained snapshot HTML (for UI-incapable hosts). Registers
    `${prefix}_render_snapshot` (model-visible) only when wired. Receives fileName and HTML and returns a locator
    (a local path or public URL). Delivery, saving, and URL-ification are the host implementation's responsibility."""
    legacy_ui_resource: bool = False
    """UIResource co-emission for mcp-ui legacy host compatibility (default False = fully backward compatible).
    When enabled, appends the self-contained snapshot HTML to the content[] of compose-family tool results as
    `{type:"resource", resource:{uri:"ui://kohaku/view/<intentHash>", mimeType:"text/html", text}}`
    (same shape as TS AttachOptions.legacyUiResource). A static display path for legacy hosts that do not support
    SEP-1865 and render only mcp-ui's UIResource (`ui://` prefix detection). The HTML bundles the shared renderer at
    about 1MB/result, so do not enable it on modern hosts (Claude / ChatGPT). An assembly failure is swallowed,
    reported to the observation hook, and answered normally without co-emission (fail-open)."""


# Internal: the source of a compose (NL / structured Intent).
@dataclass(frozen=True)
class _NlSource:
    text: str


@dataclass(frozen=True)
class _IntentSource:
    intent: IntentInput


_ComposeSource = _NlSource | _IntentSource


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def attach_kohaku_to_mcp_server(
    server: Server, deps: McpHostDeps, options: AttachOptions
) -> None:
    """Wire kohaku's MCP Apps profile into a low-level mcp Server.

    Registers the tools (compose / resolve_binding / event / action / render_snapshot / intent-tools) and the
    ui:// resource (shared renderer). Transport-independent (attaches to server only).
    """
    try:
        import mcp.types as mcp_types
        from mcp.server.lowlevel.helper_types import ReadResourceContents
    except ImportError as exc:  # pragma: no cover — guidance for environments without mcp installed
        raise RuntimeError(_MCP_MISSING_MESSAGE) from exc

    prefix = options.tool_prefix if options.tool_prefix is not None else "kohaku"
    fallback_principal = deps.principal if deps.principal is not None else _ANONYMOUS

    async def _current_principal() -> Principal:
        """Resolves the principal for THIS tool call (see `McpHostDeps.resolve_principal`'s doc comment for the
        full fallback order). Called once per tool call, inside each handler's own `_safe_tool`-wrapped body —
        never memoized across calls, since a shared `Server` (see `sales_api.mcp_http`) serves every session."""
        return await _principal_of(deps, fallback_principal)

    # Memoized deps.domain.list_operations() names (write-scope hardening; see _issue_capability). McpHostDeps
    # is frozen, so the cache lives here as a closure variable rather than on deps (unlike host_rest's
    # per-deps field). list_operations is async and must not be re-awaited on every compose.
    _allowed_actions_cache: frozenset[str] | None = None

    async def _allowed_actions() -> frozenset[str]:
        nonlocal _allowed_actions_cache
        if _allowed_actions_cache is None:
            ops = await deps.domain.list_operations()
            _allowed_actions_cache = frozenset(op.name for op in ops)
        return _allowed_actions_cache

    def _tool_error(message: str) -> Any:
        """Turn a tool-handler failure into a structured tool error (isError) rather than an RPC exception."""
        result = mcp_types.CallToolResult(
            content=[mcp_types.TextContent(type="text", text=message)],
            isError=True,
        )
        # MCP 2026-07-28 (SEP-2322) requires every result to carry resultType. An error is still a
        # *complete* result (this profile never produces an MRTR "input_required" interim result) — see
        # _safe_tool's doc comment. CallToolResult's pydantic model is extra="allow" (passthrough), so an
        # SDK-v1 client round-trips this unknown field unmodified. model_copy(update=...) (rather than passing
        # resultType as a constructor kwarg) keeps this mypy --strict clean: pydantic v2's dataclass_transform
        # only types declared fields as constructor kwargs, even though extra="allow" accepts more at runtime.
        return result.model_copy(update={"resultType": "complete"})

    async def _safe_tool(endpoint: str, fn: Callable[[], Awaitable[Any]]) -> Any:
        """Route a handler failure through the observation hook then convert it to a tool error (the success return value is unchanged).

        An arbitrary/untyped exception's message never reaches the caller (it may leak internals); a typed
        host error (kohaku.host_core.is_typed_host_error — SpecError/ComposeError/QueryRefError, or any
        exception carrying a string `code`) still has its own message pass through.

        Also the single point where MCP 2026-07-28's required `resultType` field is stamped onto every
        *successful* tool result this profile returns (every handler routes its return value through
        _safe_tool, mirroring TS host-mcp-apps' safeTool), and where the tool call's request-id correlation id
        (_correlation_id_from_request_context) is attached to a reported failure.
        """
        try:
            result = await fn()
            if isinstance(result, mcp_types.CallToolResult):
                result = result.model_copy(update={"resultType": "complete"})
            return result
        except Exception as exc:  # noqa: BLE001 — map to a tool error, symmetric with the REST surface's 400
            await _report_mcp_error(
                deps,
                endpoint,
                exc,
                correlation_id=_correlation_id_from_request_context(),
                trace_context=_trace_context_from_request_context(),
            )
            message = str(exc) if is_typed_host_error(exc) else _TOOL_INTERNAL_ERROR_MESSAGE
            return _tool_error(message)

    async def _compose_and_package(
        source: _ComposeSource, locale: str | None, principal: Principal
    ) -> Any:
        result = await _compose_with_fixation(source, deps, locale, principal)
        try:
            allowed = await _allowed_actions()
        except Exception as exc:  # noqa: BLE001 — reported, then fail-closed for writes (delivery proceeds)
            await _report_mcp_error(deps, "compose.capability", exc)
            allowed = frozenset()
        dropped: list[str] = []
        capability = await _issue_capability(
            result.spec,
            principal,
            deps.authz,
            allowed_actions=allowed,
            on_dropped_action=dropped.append,
        )
        for action in dropped:
            await _report_mcp_error(deps, "compose.capability", _WriteScopeDroppedError(action))
        await _audit_compose(deps, result, "compose")
        # Preresolve the initial data on the server side and co-embed it in the tool result's _meta.
        # _meta does not enter the model's context and is transferred only to the widget.
        # `preresolved_refs` is the full pre-budget map of every ref already resolved here — handed to
        # _snapshot_html_for below so the legacyUiResource co-emission (which needs the identical ref
        # set) does not re-invoke domain.invoke for refs already resolved here.
        initial_data, preresolved_refs = await _preresolve_initial_data(result.spec, deps, principal)
        # The capability token is co-embedded in _meta for the same reason as INITIAL_DATA_META_KEY (see
        # CAPABILITY_META_KEY's doc comment): structuredContent enters the model's context, so a bearer write
        # token must never ride there.
        meta: dict[str, Any] = {
            **tool_ui_meta(resource_uri=RENDERER_RESOURCE_URI),
            INITIAL_DATA_META_KEY: {ref: td.to_wire() for ref, td in initial_data.items()},
            CAPABILITY_META_KEY: capability,
        }
        # content[0] is always the text fallback (MCPAPP-FBK-001). The legacy UIResource is placed after.
        content: list[Any] = [
            mcp_types.TextContent(type="text", text=spec_to_text(result.spec))
        ]
        if options.legacy_ui_resource:
            # Static-snapshot co-emission for mcp-ui legacy hosts. An assembly failure (unbuilt renderer, data
            # resolution failure) is swallowed, reported to the observation hook, and falls back to a normal response
            # without co-emission (fail-open — the legacy-compat add-on does not drag down the actual delivery). Same shape as TS.
            try:
                snapshot_html = await _snapshot_html_for(
                    result, deps, options, principal, preresolved_refs
                )
                content.append(
                    mcp_types.EmbeddedResource(
                        type="resource",
                        resource=mcp_types.TextResourceContents(
                            uri=cast(Any, f"ui://kohaku/view/{result.spec.intent.hash}"),
                            mimeType="text/html",
                            text=snapshot_html,
                        ),
                    )
                )
            except Exception as exc:  # noqa: BLE001 — fail-open
                await _report_mcp_error(deps, "compose.legacyUiResource", exc)
        return mcp_types.CallToolResult(
            content=content,
            # capability is deliberately NOT included here (see CAPABILITY_META_KEY's doc comment):
            # structuredContent is model-visible, and a bearer write token must never enter the model's context.
            structuredContent={"spec": result.spec.to_wire()},
            _meta=meta,
        )

    # --- Tool definitions (name -> Tool + handler) --------------------------
    registered: list[tuple[Any, Callable[[JsonObject], Awaitable[Any]]]] = []

    # model-visible: natural language -> UI
    async def _handle_compose(args: JsonObject) -> Any:
        async def _run() -> Any:
            principal = await _current_principal()
            return await _compose_and_package(
                _NlSource(text=cast(str, args["question"])), _locale_of(args), principal
            )

        return await _safe_tool(f"{prefix}_compose", _run)

    registered.append(
        (
            mcp_types.Tool(
                name=f"{prefix}_compose",
                title="Compose a UI for business data",
                description=(
                    "Converts a natural-language question into a normalized Intent and composes a declarative UI Spec. "
                    "The result includes both a text summary and a structured Spec for UI-capable hosts."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "question": {
                            "type": "string",
                            "minLength": 1,
                            "description": "Natural-language question (Japanese supported)",
                        },
                        "locale": _LOCALE_PROPERTY,
                    },
                    "required": ["question"],
                },
                _meta=tool_ui_meta(resource_uri=RENDERER_RESOURCE_URI, visibility=["model"]),
            ),
            _handle_compose,
        )
    )

    # model-visible: self-contained snapshot HTML for UI-incapable hosts.
    # If snapshot_writer is unwired, do not register this tool (exposing it without a write hook is pointless).
    if options.snapshot_writer is not None:
        snapshot_writer = options.snapshot_writer

        async def _handle_render_snapshot(args: JsonObject) -> Any:
            async def _run() -> Any:
                principal = await _current_principal()
                spec, html = await _build_snapshot(
                    _NlSource(text=cast(str, args["question"])),
                    deps,
                    options,
                    principal,
                    _locale_of(args),
                )
                # The file name is derived from the intent hash (identical displays coalesce into the same file and do not collide).
                locator = await snapshot_writer(f"snapshot-{spec.intent.hash}.html", html)
                # Do not return the HTML body (about 1MB) to the model. Put only the locator and the specToText summary into content.
                text = (
                    "Generated self-contained snapshot HTML.\n"
                    f"Snapshot: {locator}\n"
                    "Use this URL's or local path's HTML directly for display (open it in a browser). "
                    "Do not build your own UI.\n\n" + spec_to_text(spec)
                )
                return mcp_types.CallToolResult(
                    content=[mcp_types.TextContent(type="text", text=text)],
                    structuredContent={"path": locator, "spec": spec.to_wire()},
                )

            return await _safe_tool(f"{prefix}_render_snapshot", _run)

        registered.append(
            (
                mcp_types.Tool(
                    name=f"{prefix}_render_snapshot",
                    title="Generate self-contained snapshot HTML",
                    description=(
                        "For UI-incapable hosts (CLI, etc.), generates self-contained HTML rendered with the same "
                        "shared renderer as the Web. Since it embeds the UI Spec and resolved data in a single file, "
                        "use the returned URL's or local path's HTML directly for display (if the model builds its own "
                        "UI from the tool result, its rendering will diverge from the Web)."
                    ),
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "question": {
                                "type": "string",
                                "minLength": 1,
                                "description": "Natural-language question (Japanese supported)",
                            },
                            "locale": _LOCALE_PROPERTY,
                        },
                        "required": ["question"],
                    },
                    # This generates an HTML file rather than opening an iframe view, so it has no resourceUri.
                    _meta=tool_ui_meta(visibility=["model"]),
                ),
                _handle_render_snapshot,
            )
        )

    # model-visible: the typed tools derived from the Intent catalog
    for tool in options.intent_tools if options.intent_tools is not None else []:
        registered.append(
            (
                mcp_types.Tool(
                    name=tool.name,
                    description=tool.description,
                    inputSchema=_with_locale_input(tool.input_schema, tool.name),
                    _meta=tool_ui_meta(resource_uri=RENDERER_RESOURCE_URI, visibility=["model"]),
                ),
                _make_intent_handler(tool, _safe_tool, _compose_and_package, _current_principal),
            )
        )

    # app-only: data resolution from the iframe (the landing point of reference-passing)
    async def _handle_resolve_binding(args: JsonObject) -> Any:
        async def _run() -> Any:
            # Resolved once for this call (see McpHostDeps.resolve_principal's doc comment) — used only as
            # the fallback below when the AuthzPort's verify does not itself return a principal.
            principal = await _current_principal()
            # Server-side paging/sorting: verify the capability against base (reserved params removed) and merge
            # the reserved params into domain.invoke. Unknown `_` keys are rejected.
            split = split_reserved_params(cast(str, args["ref"]))
            assert_known_reserved_params(split.reserved)
            if split.base.source != deps.query_source:
                return _tool_error(f'unknown query source "{split.base.source}"')
            capability = cast(str, args["capability"])
            verdict = await deps.authz.verify(
                capability, VerifyRequest(kind="read", ref=split.base.raw)
            )
            if not verdict.ok:
                return _tool_error(f"capability denied: {verdict.reason or ''}")
            data = await deps.domain.invoke(
                split.base.path,
                {**split.base.params, **split.reserved},
                InvocationContext(
                    principal=verdict.principal or principal, capability=capability
                ),
            )
            rows = len(data.rows) if isinstance(data, TabularData) else 0
            return mcp_types.CallToolResult(
                content=[
                    mcp_types.TextContent(
                        type="text", text=f"resolved {rows} rows from {split.base.raw}"
                    )
                ],
                structuredContent={"data": _to_wire_data(data)},
            )

        return await _safe_tool(f"{prefix}_resolve_binding", _run)

    registered.append(
        (
            mcp_types.Tool(
                name=f"{prefix}_resolve_binding",
                description="(app-only) Resolves a Spec's $ref with a capability and returns bulk data",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "ref": {"type": "string"},
                        "capability": {"type": "string"},
                    },
                    "required": ["ref", "capability"],
                },
                _meta=tool_ui_meta(visibility=["app"]),
            ),
            _handle_resolve_binding,
        )
    )

    # app-only: component event -> Intent delta -> recompose
    async def _handle_event(args: JsonObject) -> Any:
        async def _run() -> Any:
            principal = await _current_principal()
            intent_arg = cast(dict[str, Any], args["intent"])
            intent_params = cast(JsonObject, intent_arg["params"])
            payload = cast(JsonObject, args.get("payload", {}))
            # Mirrors TS's JsonObjectSchema on kohaku_event's payload/intent.params (validated there at the
            # SDK's own input-schema layer, before the handler ever runs, the same way kohaku_action's
            # payload already is) — the Python mcp SDK's tool schemas are JSON Schema hints only (no runtime
            # validator wired in), so the depth cap is enforced here instead.
            if not _json_depth_ok(intent_params) or not _json_depth_ok(payload):
                return _tool_error(f"payload nesting exceeds the maximum depth ({MAX_JSON_OBJECT_DEPTH})")
            current = finalize_intent(
                IntentInput(canonical=cast(str, intent_arg["canonical"]), params=intent_params)
            )
            locale = _locale_of(args)
            on = cast(str, args["on"])
            normalized = await deps.compose.semantic.normalize(
                GuiAction(kind="gui", action=on, params=payload, current=current),
                _mcp_session(locale, principal),
            )
            # Record view.interacted symmetrically with the REST surface's /events (which records it before
            # recomposing, via KohakuHostDeps.recorder). Fail-open: a recording failure must not block
            # recomposition, and is reported to the observation hook instead.
            if deps.recorder is not None:
                recorder = deps.recorder

                async def _record_interacted() -> None:
                    await recorder.interacted(
                        intent_hash=current.hash,
                        component_id=on.split(".")[0],
                        on=on,
                        payload=payload,
                        surface="mcp-app",
                    )

                await _host_core_fail_open(
                    _record_interacted,
                    lambda exc: _report_mcp_error(deps, f"{prefix}_event", exc),
                )
            return await _compose_and_package(
                _IntentSource(
                    intent=IntentInput(canonical=normalized.canonical, params=normalized.params)
                ),
                locale,
                principal,
            )

        return await _safe_tool(f"{prefix}_event", _run)

    registered.append(
        (
            mcp_types.Tool(
                name=f"{prefix}_event",
                description="(app-only) Recomposes a component event as an Intent delta",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "intent": {
                            "type": "object",
                            "properties": {
                                "canonical": {"type": "string"},
                                "params": {"type": "object"},
                            },
                            "required": ["canonical", "params"],
                        },
                        "on": {"type": "string"},
                        "payload": {"type": "object", "default": {}},
                        "locale": _LOCALE_PROPERTY,
                    },
                    "required": ["intent", "on"],
                },
                _meta=tool_ui_meta(resource_uri=RENDERER_RESOURCE_URI, visibility=["app"]),
            ),
            _handle_event,
        )
    )

    # app-only: direct write path (presentForm submit / action.button)
    async def _handle_action(args: JsonObject) -> Any:
        async def _run() -> Any:
            # Resolved once for this call (see McpHostDeps.resolve_principal's doc comment) — used only as
            # the fallback below when the AuthzPort's verify does not itself return a principal.
            principal = await _current_principal()
            action = cast(str, args["action"])
            capability = cast(str, args["capability"])
            payload = cast(JsonObject, args.get("payload", {}))
            # Mirrors TS's JsonObjectSchema on kohaku_action's payload (validated there at the SDK's own
            # input-schema layer, before the handler ever runs) — the Python mcp SDK's tool schemas are JSON
            # Schema hints only (no runtime validator wired in), so the depth cap is enforced here instead.
            if not _json_depth_ok(payload):
                return _tool_error(f"payload nesting exceeds the maximum depth ({MAX_JSON_OBJECT_DEPTH})")
            # Reject an action name the DomainPort does not expose before even attempting capability
            # verification (defense in depth for a host that does not honor this tool's app-only visibility
            # hint, or a prompt-injected instruction — see CAPABILITY_META_KEY's doc comment). Fail-closed on
            # a list_operations() rejection too — every action is "unknown" for this call, and the failure is
            # reported to the observability hook.
            try:
                allowed = await _allowed_actions()
            except Exception as exc:  # noqa: BLE001 — fail-closed (deny every action), reported below
                await _report_mcp_error(deps, f"{prefix}_action.allowedActions", exc)
                allowed = frozenset()
            if action not in allowed:
                return _tool_error("unknown action")
            payload_bytes = len(canonical_stringify(payload).encode("utf-8"))
            if payload_bytes > MAX_ACTION_PAYLOAD_BYTES:
                return _tool_error(
                    f"payload exceeds the maximum size ({MAX_ACTION_PAYLOAD_BYTES} bytes)"
                )
            # Verify against the write scope, symmetric with the REST surface (/binding/action). Denial -> tool error.
            verdict = await deps.authz.verify(capability, VerifyRequest(kind="write", ref=action))
            if not verdict.ok:
                return _tool_error(f"capability denied: {verdict.reason or ''}")
            result = await deps.domain.invoke(
                action,
                payload,
                InvocationContext(
                    principal=verdict.principal or principal, capability=capability
                ),
            )
            # Side-effect declaration (optional): put the refs the write invalidates and the per-ref new versions into
            # the response (same shape as REST). The write is already committed. An effects failure does not make
            # the committed write look like an error: swallow it individually, report it to the observation hook, and
            # return success with only {result} (the effects-omitted backward-compatible shape) — failing the whole
            # _run would make _safe_tool set isError, and a client retry could duplicate a non-idempotent write.
            structured: dict[str, Any] = {"result": result if result is not None else None}
            if deps.action_effects is not None:
                try:
                    effects = await deps.action_effects(action, payload, result)
                    if effects.invalidates is not None:
                        structured["invalidates"] = effects.invalidates
                    if effects.refVersions is not None:
                        structured["refVersions"] = effects.refVersions
                except Exception as exc:  # noqa: BLE001 — an effects failure does not drag down the committed write
                    await _report_mcp_error(deps, f"{prefix}_action", exc)
            return mcp_types.CallToolResult(
                content=[
                    mcp_types.TextContent(type="text", text=f"Executed action {action}")
                ],
                structuredContent=structured,
            )

        return await _safe_tool(f"{prefix}_action", _run)

    registered.append(
        (
            mcp_types.Tool(
                name=f"{prefix}_action",
                description="(app-only) Executes a declared action with a capability and returns a result with a side-effect declaration",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "action": {"type": "string"},
                        "payload": {"type": "object", "default": {}},
                        "capability": {"type": "string"},
                    },
                    "required": ["action", "capability"],
                },
                _meta=tool_ui_meta(visibility=["app"]),
            ),
            _handle_action,
        )
    )

    by_name: dict[str, Callable[[JsonObject], Awaitable[Any]]] = {
        tool_def.name: handler for tool_def, handler in registered
    }
    tools_list: list[Any] = [tool_def for tool_def, _ in registered]

    # --- Register handlers on the low-level Server --------------------------
    # The mcp SDK's registration decorators are untyped (returning an untyped callback), so call them through Any
    # (the boundary's public signature keeps server: Server).
    srv: Any = server

    @srv.list_tools()  # type: ignore[untyped-decorator]  # the mcp SDK's registration decorators are untyped
    async def _list_tools() -> Any:
        # MCP 2026-07-28 (SEP-2549): tools/list must carry ttlMs + cacheScope (CacheableResult). This mcp SDK
        # version's list_tools() decorator accepts a full ListToolsResult return ("new style", alongside the
        # legacy bare list[Tool]) and ListToolsResult's pydantic model is extra="allow", so this is a small,
        # additive change here — unlike the TS profile's McpServer, which exposes no equivalent post-hoc hook
        # for tools/list (see server.ts's item-5 doc comment / design.md's migration-plan section for why the
        # same enhancement was skipped there). tools_list is registration order (deterministic; see the
        # "MCP 2026-07-28 minor #3" test). model_copy(update=...) rather than constructor kwargs for the same
        # mypy --strict reason as _tool_error's doc comment above.
        return mcp_types.ListToolsResult(tools=tools_list).model_copy(
            update={"ttlMs": _LIST_RESULT_TTL_MS, "cacheScope": _LIST_RESULT_CACHE_SCOPE}
        )

    # NOTE on tool-call cancellation (parity gap with the TS profile's `extra.signal`, tracked deliberately
    # rather than papered over): the installed mcp SDK's low-level Server exposes no per-call cancellation
    # object on RequestContext (see mcp.shared.context.RequestContext — no `signal` / `cancel_event` field as
    # of this SDK version) for a tool handler to check or thread into compose()'s `abort` parameter (which
    # already exists on this Python port — see ComposeFixationContext.abort in kohaku.host_core.fixation).
    # Cancellation instead happens structurally: a client's CancelledNotification cancels the anyio task group
    # running this request (server.py's `tg.cancel_scope.cancel()`), which raises inside whichever `await` this
    # coroutine (and anything it awaits — domain.invoke, the LLM call) happens to be suspended at, unwinding the
    # call without ever reaching a return. That already stops wasted work on a cancelled call without any
    # explicit signal-threading here; there is simply no separate AbortSignal-like object to pass to
    # composeWithFixation the way the TS profile's `extra.signal` is threaded through. If a future mcp SDK
    # version adds a per-request cancellation token to RequestContext, thread it into `_compose_with_fixation`'s
    # `ComposeFixationContext(materialize=deps.compose, abort=...)` the same way the TS `abort` parameter is used.
    @srv.call_tool()  # type: ignore[untyped-decorator]
    async def _call_tool(name: str, arguments: JsonObject) -> Any:
        handler = by_name.get(name)
        if handler is None:
            return _tool_error(f'unknown tool "{name}"')
        return await handler(arguments)

    @srv.list_resources()  # type: ignore[untyped-decorator]
    async def _list_resources() -> Any:
        # MCP 2026-07-28 (SEP-2549): resources/list must also carry ttlMs + cacheScope. Same "new style"
        # full-ListResourcesResult return as _list_tools above (Server.list_resources's decorator supports
        # it too) — see that function's doc comment for why this is safe/small here but was skipped in TS.
        result = mcp_types.ListResourcesResult(
            resources=[
                mcp_types.Resource(
                    uri=cast(Any, RENDERER_RESOURCE_URI),
                    name="kohaku-renderer",
                    title="kohaku shared renderer",
                    description="Shared renderer that renders the UI Spec with the same rendering code as the Web",
                    mimeType=RESOURCE_MIME_TYPE,
                    # Resource-side UI metadata (SEP-1865). Explicitly declares csp as an empty allowlist to tell the host
                    # "no external origins needed" (symmetric with the TS registerResource).
                    _meta=resource_ui_meta(),
                )
            ],
        )
        # model_copy(update=...) rather than constructor kwargs — see _tool_error's doc comment.
        return result.model_copy(
            update={"ttlMs": _LIST_RESULT_TTL_MS, "cacheScope": _LIST_RESULT_CACHE_SCOPE}
        )

    @srv.read_resource()  # type: ignore[untyped-decorator]
    async def _read_resource(uri: Any) -> Any:
        # NOTE: resources/read is NOT given ttlMs/cacheScope (unlike _list_tools / _list_resources above):
        # this mcp SDK version's read_resource() decorator (see mcp.server.lowlevel.server.Server.read_resource)
        # always builds its own ReadResourceResult from the Iterable[ReadResourceContents] this function
        # returns and offers no "new style" full-ReadResourceResult return path the way list_tools /
        # list_resources do, so there is no small, non-fragile hook to attach top-level result fields here.
        # Deferred to the SDK v2 migration (mcp 2.x's MCPServer) — see design.md's migration-plan section.
        if str(uri).rstrip("/") != RENDERER_RESOURCE_URI:
            raise ValueError(f"unknown resource: {uri}")
        html = await _get_renderer_html(options)
        # The contents-side `_meta.ui` takes precedence over the listing side (SEP-1865). Put the same value on both
        # (ReadResourceContents.meta is mapped by the lowlevel server into the `_meta` key).
        return [
            ReadResourceContents(
                content=html, mime_type=RESOURCE_MIME_TYPE, meta=resource_ui_meta()
            )
        ]


# ---------------------------------------------------------------------------
# Internal logic for compose / fixation / reference resolution (independent of mcp types)
# ---------------------------------------------------------------------------


def _fixation_host(deps: McpHostDeps) -> FixationDeliveryHost:
    """Adapts McpHostDeps into the FixationDeliveryHost surface kohaku.host_core's fixation helpers consume.

    run_self_heal spawns the self-heal call as a background task (_spawn_fixation_task, unchanged) and returns
    immediately without awaiting its completion — matching pre-extraction MCP behavior exactly (fire-and-forget,
    unlike the REST profile which awaits self-heal serialized under its fixation lock). `kind` is mapped to
    MCP's own (pre-existing) endpoint-string convention.
    """

    async def _run_self_heal(
        tenant: str | None,  # noqa: ARG001 — the MCP profile never resolves a tenant
        intent_hash: str,  # noqa: ARG001 — carried by the spawned coroutine's closure, not needed here
        fn: Callable[[], Awaitable[None]],
        kind: Any,
    ) -> None:
        endpoint = (
            "fixation.refreshFingerprint" if kind == "refresh_fingerprint" else "fixation.invalidate"
        )
        _spawn_fixation_task(deps, endpoint, fn())

    return FixationDeliveryHost(
        run_self_heal=_run_self_heal,
        lookup=deps.fixation_lookup,
        fixations=deps.fixations,
    )


async def _compose_with_fixation(
    source: _ComposeSource,
    deps: McpHostDeps,
    locale: str | None = None,
    principal: Principal | None = None,
) -> ComposeResult:
    # One session per tool call: the caller-provided locale rides SessionContext.locale so NL
    # normalization, the fixation gate, and the compose policy (ComposeContext.policyFor) all see it.
    # `principal` here is this call's already-resolved principal (see McpHostDeps.resolve_principal's doc
    # comment — every caller of this function resolves it once via `_current_principal()` before calling in),
    # attached symmetrically with _handle_event's own _mcp_session(locale, principal) call — without it,
    # SemanticPort.normalize / policy_for / the fixation lookup would see an anonymous session on the compose
    # path only, diverging from the kohaku_event path for the same resolved principal.
    #
    # NOTE (mirrors host-core's TS resolveIntent, which this Python port does not yet have — see
    # kohaku.host_core): the "intent" and "nl" branches below duplicate TS host-core's resolveIntent
    # inline instead of delegating to a shared helper, because no Python host_core module for it exists yet.
    session = _mcp_session(locale, principal)
    if isinstance(source, _IntentSource):
        intent = finalize_intent(source.intent)
    else:
        normalized = await deps.compose.semantic.normalize(
            NLQuery(kind="nl", text=source.text), session
        )
        intent = finalize_intent(
            IntentInput(canonical=normalized.canonical, params=normalized.params)
        )

    # Delegates the fixation shortcut -> staleness check -> self-heal -> normal-compose-fallback sequence to
    # kohaku.host_core (shared with kohaku.host_rest). The MCP profile has a single ComposeContext, so it is
    # passed as both the materialize and (by omission, defaulting to materialize) the normal-compose context.
    return await _host_core_compose_with_fixation(
        intent, session, ComposeFixationContext(materialize=deps.compose), _fixation_host(deps)
    )


def _spawn_fixation_task(deps: McpHostDeps, endpoint: str, coro: Awaitable[None]) -> None:
    """Run a self-healing coroutine off the delivery path and report failures to the observation hook (delivery is not stopped)."""

    async def _run() -> None:
        try:
            await coro
        except Exception as exc:  # noqa: BLE001 — a self-healing failure does not propagate into delivery
            await _report_mcp_error(deps, endpoint, exc)

    task = asyncio.ensure_future(_run())
    task.add_done_callback(lambda t: t.exception())  # prevent the unobserved-exception warning


async def _report_mcp_error(
    deps: McpHostDeps,
    endpoint: str,
    error: BaseException,
    *,
    correlation_id: str | None = None,
    trace_context: TraceContext | None = None,
) -> None:
    """Failure-path observability. Silent if on_error is unwired. Hook throws are swallowed (observation
    only), via kohaku.host_core.notify_hook (the shared swallow-on-throw building block, also consumed by the
    REST profile's report_host_error). `correlation_id` / `trace_context` (optional; see McpErrorInfo's doc
    comment) are passed only by _safe_tool's except branch today — every other call site in this module
    keeps reporting None, unchanged from before either parameter existed."""
    await _host_core_notify_hook(
        deps.on_error,
        McpErrorInfo(endpoint=endpoint, error=error, correlation_id=correlation_id, trace_context=trace_context),
    )


async def _record_view_fallback(
    recorder: ViewRecorderProtocol, spec: UISpec, *, surface: str
) -> None:
    """Record view.fallback when the spec includes a fallback (source of truth: spec.provenance.fallback,
    not the compose trace — capability-negotiation downgrade can recur on a cache hit, which the trace alone
    would miss). Mirrors the REST profile's record_fallback_if_any (kohaku.host_rest._routes.compose) so both
    profiles agree on when a fallback is recorded; kept as a local duplicate rather than a shared host_core
    helper because host_rest and host_mcp are independent siblings in the Python layer contract (see
    pyproject.toml's importlinter layers) and Python's host_core does not yet host this logic (TS's
    `@kohaku-ui/host-core` does — see that package's view-recorder.ts)."""
    fallback = spec.provenance.fallback
    if fallback is None:
        return
    await recorder.fallback(
        spec=spec,
        reason=fallback.reason,
        kind=fallback.kind if fallback.kind is not None else "generation",
        surface=surface,
    )


async def _audit_compose(deps: McpHostDeps, result: ComposeResult, endpoint: str) -> None:
    """compose + audit record (fail-open), shared by _compose_and_package and _build_snapshot.

    When `deps.recorder` (ViewRecorderProtocol) is wired, records both `composed` and `fallback`
    (mirroring the REST profile's _record_composed + record_fallback_if_any); when only the legacy
    `deps.on_composed` is wired, only that is called (the old, narrower contract). `recorder` takes
    priority when both are present, so a product migrating from one to the other does not double-record.

    A cancelled compose (the caller's abort fired) is not a generation failure and observer.on_error
    already received phase="cancelled" from the composer — skip the audit record entirely so a client
    disconnect/timeout does not inflate audit counts (parity with the REST profile's guard).

    Fail-open: a recording failure is swallowed (via kohaku.host_core.fail_open) and reported to the
    observation hook (on_error) rather than propagating — delivery availability takes priority over a
    missed audit record.
    """
    if result.trace.cancelled:
        return
    recorder = deps.recorder
    on_composed = deps.on_composed

    async def _record() -> None:
        if recorder is not None:
            await recorder.composed(spec=result.spec, trace=result.trace, surface="mcp-app")
            await _record_view_fallback(recorder, result.spec, surface="mcp-app")
        elif on_composed is not None:
            await on_composed(result.spec, result.trace)

    await _host_core_fail_open(_record, lambda exc: _report_mcp_error(deps, endpoint, exc))


async def _issue_capability(
    spec: UISpec,
    principal: Principal,
    authz: AuthzPort,
    *,
    allowed_actions: frozenset[str] | None = None,
    on_dropped_action: Callable[[str], None] | None = None,
) -> str:
    """SPEC §5 A1: a component with `data.bind` fully enumerates the effective refs reachable via the cartesian
    product of values and issues each variant with a read scope. An action.invoke action name the UI declares is
    issued with write.

    The issuance rule itself lives in kohaku.host_core.issue_capability_for_spec (which in turn consumes the
    spec-layer collect_capability_scopes, the single source of truth), shared with the REST surface's
    issue_capability_for_spec so both profiles agree on the issuance rule.

    allowed_actions / on_dropped_action mirror the REST surface's write-scope hardening: a write scope whose
    action is not in allowed_actions is dropped before issuance and reported via on_dropped_action.
    """
    return await _host_core_issue_capability_for_spec(
        authz,
        principal,
        spec,
        allowed_actions=allowed_actions,
        on_dropped_action=on_dropped_action,
    )


async def _resolve_variant(
    variant: str, deps: McpHostDeps, principal: Principal
) -> TabularData | None:
    """Shared helper that preresolves a single effective ref with read. An unknown source is None (not co-embedded)."""
    split = split_reserved_params(variant)
    assert_known_reserved_params(split.reserved)
    if split.base.source != deps.query_source:
        return None
    resolved = await deps.domain.invoke(
        split.base.path,
        {**split.base.params, **split.reserved},
        InvocationContext(principal=principal),
    )
    return cast(TabularData, resolved)


class _PreresolveDeadline:
    """Mutable flag shared by every in-flight `_resolve_ref_bounded` call for one `_preresolve_initial_data`
    invocation (a plain object rather than a closure `nonlocal`, since the flag must be visible to tasks
    created before it is set). Mirrors TS resolveRefsBounded's `deadlineExceeded` local."""

    __slots__ = ("exceeded",)

    def __init__(self) -> None:
        self.exceeded = False


async def _resolve_ref_bounded(
    ref: str,
    deps: McpHostDeps,
    principal: Principal,
    semaphore: asyncio.Semaphore,
    results: dict[str, TabularData],
    deadline: _PreresolveDeadline,
    timeout_s: float,
) -> None:
    """Resolves one ref under the shared concurrency semaphore, writing a successful result into `results`.

    Once `deadline.exceeded` is set (the overall preresolution deadline elapsed), a task that has not started
    its DomainPort call yet skips it entirely, and a task already in flight discards its eventual outcome
    (success or failure) instead of writing to `results` — reported via the same per-ref fail-open path as an
    ordinary failure, with a message identifying it as a deadline discard. Mirrors TS's resolveOne.

    `timeout_s` is a parameter (rather than the module-level PRERESOLVE_TIMEOUT_S constant) so
    _resolve_refs_bounded can share this exact primitive between _preresolve_initial_data and
    _snapshot_html_for — both pass PRERESOLVE_TIMEOUT_S today, but keeping it a parameter avoids a
    hidden coupling to that specific caller.
    """
    async with semaphore:
        if deadline.exceeded:
            return
        try:
            # per-ref timeout: cut off so a ref that never returns does not hold its concurrency slot forever.
            resolved = await asyncio.wait_for(
                _resolve_variant(ref, deps, principal), timeout=timeout_s
            )
        except Exception as exc:  # noqa: BLE001 — per-ref fail-open (including timeout)
            if deadline.exceeded:
                await _report_mcp_error(deps, "compose.initialData", _discard_error(ref, exc))
            else:
                await _report_mcp_error(deps, "compose.initialData", exc)
            return
        if deadline.exceeded:
            # Resolved successfully, but too late: the caller already stopped waiting and moved on.
            await _report_mcp_error(deps, "compose.initialData", _discard_error(ref))
            return
        if resolved is None:
            return  # do not co-embed an unknown source
        results[ref] = resolved


def _discard_error(ref: str, cause: BaseException | None = None) -> RuntimeError:
    """Builds the observability-hook error for a ref discarded by the overall preresolution deadline (ops)."""
    detail = f" ({cause})" if cause is not None else ""
    return RuntimeError(
        f"Initial-data preresolution discarded (total deadline {PRERESOLVE_TOTAL_TIMEOUT_S}s "
        f"exceeded before this ref resolved): {ref}{detail}"
    )


async def _resolve_refs_bounded(
    refs: list[str],
    deps: McpHostDeps,
    principal: Principal,
    *,
    timeout_s: float,
    total_timeout_s: float,
) -> dict[str, TabularData]:
    """Resolves `refs` with bounded concurrency (PRERESOLVE_CONCURRENCY workers via a Semaphore) subject to an
    overall wall-clock deadline (`total_timeout_s`), on top of a per-ref timeout (`timeout_s`). Port of TS
    initial-data.ts's resolveRefsBounded, shared here by _preresolve_initial_data (the `_meta` co-embed) and
    _snapshot_html_for (the self-contained-snapshot ref set) so a single hung DomainPort dependency can no
    longer stall either one — previously (§2 #6) _snapshot_html_for resolved refs one at a time with neither a
    per-ref timeout nor an overall deadline, so one stuck ref stopped render_snapshot from ever returning.

    Once `total_timeout_s` elapses, no further refs are claimed and any still-in-flight resolution's eventual
    outcome is discarded (see _resolve_ref_bounded). Returns whatever resolved in time; a ref missing from the
    result is either an unknown source (deliberately not embeddable), a genuine per-ref failure/timeout, or a
    deadline discard — callers that need to tell these apart pre-filter unknown-source refs before calling this
    (see _snapshot_html_for).
    """
    resolved: dict[str, TabularData] = {}
    if not refs:
        return resolved
    semaphore = asyncio.Semaphore(PRERESOLVE_CONCURRENCY)
    deadline = _PreresolveDeadline()
    tasks = [
        asyncio.ensure_future(
            _resolve_ref_bounded(ref, deps, principal, semaphore, resolved, deadline, timeout_s)
        )
        for ref in refs
    ]
    # asyncio.wait (unlike wait_for) does not cancel pending tasks on timeout: any ref still resolving (or
    # still queued behind the concurrency limit) when the deadline elapses keeps running in the background,
    # and _resolve_ref_bounded discards its outcome via the `deadline` flag flipped below.
    _done, pending = await asyncio.wait(tasks, timeout=total_timeout_s)
    if pending:
        deadline.exceeded = True
    return resolved


async def _preresolve_initial_data(
    spec: UISpec, deps: McpHostDeps, principal: Principal
) -> tuple[dict[str, TabularData], dict[str, TabularData]]:
    """Preresolve the initial data `{effective ref: TabularData}` co-embedded in the tool result's _meta.

    - Fill each component's initial variant ($ref) across all components first, and fill bind's other variants with the
      remaining budget (initial display has top priority). What exceeds the budget is not co-embedded (partial embedding).
    - Refs are resolved with bounded concurrency (_resolve_refs_bounded, PRERESOLVE_CONCURRENCY workers) subject
      to an overall deadline (PRERESOLVE_TOTAL_TIMEOUT_S), on top of the existing per-ref timeout. The budget
      above is still applied afterward in the fixed initial-then-secondary order, so which refs end up embedded
      on overflow does not depend on completion order.
    - per-ref fail-open: a preresolution failure (or a ref discarded by the overall deadline) skips that ref
      and reports to on_error (compose stays a success).

    Returns `(data, resolved)`: `data` is the existing budget-trimmed `_meta` co-embedding; `resolved` is the
    full pre-budget map, returned so a caller that also needs the same Spec's refs resolved for a second
    purpose (_compose_and_package's legacyUiResource co-emission, via _snapshot_html_for) can reuse this call's
    domain.invoke results instead of resolving the identical ref set a second time.
    """
    initial_refs: list[str] = []
    secondary_refs: list[str] = []
    for component in spec.components:
        if component.data is None:
            continue
        initial = parse_query_ref(component.data.ref).raw
        initial_refs.append(initial)
        for variant in enumerate_bind_variants(component.data):
            if variant != initial:
                secondary_refs.append(variant)

    # Dedup while preserving the initial-then-secondary priority order (the budget loop below walks this same
    # order), so a ref shared by several components/variants is resolved exactly once regardless of concurrency.
    ordered_refs: list[str] = []
    seen_refs: set[str] = set()
    for ref in [*initial_refs, *secondary_refs]:
        if ref in seen_refs:
            continue
        seen_refs.add(ref)
        ordered_refs.append(ref)

    resolved = await _resolve_refs_bounded(
        ordered_refs,
        deps,
        principal,
        timeout_s=PRERESOLVE_TIMEOUT_S,
        total_timeout_s=PRERESOLVE_TOTAL_TIMEOUT_S,
    )

    data: dict[str, TabularData] = {}
    used = 0
    for ref in ordered_refs:
        value = resolved.get(ref)
        if value is None:
            continue  # failed / timed out / unknown source / cut off by the overall deadline
        # Measure the budget (cumulative JSON characters) and, once exceeded, co-embed no more (partial embedding).
        size = len(json.dumps({ref: value.to_wire()}, ensure_ascii=False, separators=(",", ":")))
        if used + size > INITIAL_DATA_BUDGET_CHARS:
            break
        used += size
        data[ref] = value
    return data, resolved


async def _build_snapshot(
    source: _ComposeSource,
    deps: McpHostDeps,
    options: AttachOptions,
    principal: Principal,
    locale: str | None = None,
) -> tuple[UISpec, str]:
    """Assemble the body of the self-contained snapshot HTML. Records audit symmetrically with the compose
    surface, preresolves all bind variants of each data in the Spec via domain.invoke, and embeds them into #kohaku-snapshot.
    """
    result = await _compose_with_fixation(source, deps, locale, principal)
    # The audit record is fail-open symmetrically with the existing compose (see _audit_compose's doc comment).
    await _audit_compose(deps, result, "render_snapshot")
    # HTML assembly is shared with #6 (legacy UIResource co-emission) via _snapshot_html_for (bounded
    # concurrency + an overall deadline). Here the snapshot is the deliverable itself (no other resolution pass
    # to share with), so a resolution failure or timeout is propagated rather than swallowed (do not emit
    # incomplete HTML).
    html = await _snapshot_html_for(result, deps, options, principal)
    return result.spec, html


def _is_resolvable_ref(ref: str, deps: McpHostDeps) -> bool:
    """True when `ref`'s source matches `deps.query_source` (a cheap, I/O-free check mirroring
    _resolve_variant's own None-on-mismatch rule). Used by _snapshot_html_for to separate "not an embedding
    target" (never an error) from "should have resolved but didn't" (a genuine failure worth raising on)."""
    return split_reserved_params(ref).base.source == deps.query_source


class SnapshotResolutionIncompleteError(RuntimeError):
    """Raised when a resolvable ref could not be resolved within snapshot.ts's bounded concurrency / overall
    deadline (a genuine per-ref failure, timeout, or deadline cutoff — not an unknown-source ref, which is
    filtered out beforehand and is not an error). Carries `code` so it is recognized as a deliberate,
    host-authored error (kohaku.host_core's is_typed_host_error) — its message reaches the caller instead of
    collapsing to the generic internal-error text (see _safe_tool)."""

    code = "SNAPSHOT_RESOLUTION_INCOMPLETE"


async def _snapshot_html_for(
    result: ComposeResult,
    deps: McpHostDeps,
    options: AttachOptions,
    principal: Principal,
    preresolved: dict[str, TabularData] | None = None,
) -> str:
    """Assemble self-contained snapshot HTML from a composed result (shared by the render_snapshot tool and the
    mcp-ui legacy UIResource co-emission).

    For each data in the Spec, resolves the initial $ref and all bind variants (enumerate_bind_variants) with
    read, and embeds them into the shared renderer's #kohaku-snapshot as {spec, data}. The snapshot is the full
    amount with no budget (unlike _preresolve_initial_data's `_meta` co-embedding).

    `preresolved`, when passed, supplies already-resolved refs (_compose_and_package passes
    _preresolve_initial_data's full pre-budget map here for the legacyUiResource co-emission path, since it
    needs the identical ref set _preresolve_initial_data already resolved) — only refs missing from it are
    actually invoked here, avoiding a second round of domain.invoke calls for the same request. When omitted
    (_build_snapshot's standalone render_snapshot tool path), every ref is resolved here.

    Resolution shares _resolve_refs_bounded (bounded concurrency + an overall wall-clock deadline, the same
    primitive _preresolve_initial_data uses) rather than the previous one-ref-at-a-time loop with no timeout at
    all, so one hung dependency can no longer stall this call forever (§2 #6). Within that bound, a still-missing
    *resolvable* ref (a genuine per-ref failure, per-ref timeout, or an outstanding resolution cut off by the
    overall deadline) still raises rather than being swallowed — the snapshot must not silently embed incomplete
    data. A ref whose source does not match query_source is not an error (it is simply not an embedding target,
    same as _preresolve_initial_data / resolve_binding) and is excluded from both the "must resolve" set and the
    output.
    """
    refs: list[str] = []
    seen: set[str] = set()
    for component in result.spec.components:
        if component.data is None:
            continue
        for variant in enumerate_bind_variants(component.data):
            if variant in seen:
                continue
            seen.add(variant)
            refs.append(variant)

    resolvable_refs = [ref for ref in refs if _is_resolvable_ref(ref, deps)]
    already_resolved = preresolved if preresolved is not None else {}
    missing = [ref for ref in resolvable_refs if ref not in already_resolved]
    freshly_resolved = (
        await _resolve_refs_bounded(
            missing,
            deps,
            principal,
            timeout_s=PRERESOLVE_TIMEOUT_S,
            total_timeout_s=PRERESOLVE_TOTAL_TIMEOUT_S,
        )
        if missing
        else {}
    )

    data: dict[str, TabularData] = {}
    for ref in resolvable_refs:
        value = already_resolved.get(ref)
        if value is None:
            value = freshly_resolved.get(ref)
        if value is None:
            raise SnapshotResolutionIncompleteError(
                f"snapshot: failed to resolve ref within the bounded deadline: {ref}"
            )
        data[ref] = value
    return inject_snapshot(await _get_renderer_html(options), result.spec, data)


async def _get_renderer_html(options: AttachOptions) -> str:
    renderer = options.renderer_html
    if isinstance(renderer, str):
        return renderer
    return await renderer()


def _to_wire_data(data: object) -> Any:
    """Convert domain.invoke's return value to the wire shape (to_wire if TabularData, otherwise as-is)."""
    if isinstance(data, TabularData):
        return data.to_wire()
    return data


def _make_intent_handler(
    tool: IntentToolDef,
    safe_tool: Callable[[str, Callable[[], Awaitable[Any]]], Awaitable[Any]],
    compose_and_package: Callable[[_ComposeSource, str | None, Principal], Awaitable[Any]],
    current_principal: Callable[[], Awaitable[Principal]],
) -> Callable[[JsonObject], Awaitable[Any]]:
    """Build the handler for an intent tool (avoids late binding of the loop variable tool)."""

    async def handler(args: JsonObject) -> Any:
        # Pull the shared language input out before it reaches the intent params (ObjectSchema.parse
        # would silently strip it anyway, but the canonical intent must never see it).
        locale = _locale_of(args)
        params = {key: value for key, value in args.items() if key != "locale"}

        async def _run() -> Any:
            principal = await current_principal()
            return await compose_and_package(_IntentSource(intent=tool.to_intent(params)), locale, principal)

        return await safe_tool(tool.name, _run)

    return handler

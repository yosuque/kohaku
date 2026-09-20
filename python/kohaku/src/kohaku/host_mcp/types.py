"""Dependency / option / dataclass types for the MCP Apps profile.

Port of packages/host-mcp-apps/src/types.ts (Python's `IntentToolDef` lives in `intent_tools.py`, an earlier
extraction, rather than here — `AttachOptions.intent_tools` still references it). Split out of `server.py`
(mechanical file-layout split, Task 6): `attach_kohaku_to_mcp_server` itself, the MCP-cache-hint constants, and
the initial-data preresolution helpers stay in their own respective modules (`server.py`, `cache_hints.py`,
`initial_data.py`).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

from kohaku.composer import ComposeContext, ComposeTrace
from kohaku.host_core import FixationSelfHealApi, TraceContext
from kohaku.spec import (
    AuthzPort,
    DomainPort,
    FixationRecord,
    IntentInput,
    JsonObject,
    Principal,
    SessionContext,
    UISpec,
)

from .intent_tools import IntentToolDef

if TYPE_CHECKING:
    from mcp.server import ServerRequestContext

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
        Callable[[ServerRequestContext[Any]], Principal | Awaitable[Principal]] | None
    ) = None
    """Resolves the principal for a single tool call (from that call's mcp SDK `ServerRequestContext` —
    always available: the mcp SDK hands every registered request handler its own `ctx`). Called once per
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
    carries no language).

    Prefer keeping this a plain read and expressing any delivery gate via `fixation_admit` instead — the
    same gate function can then be shared verbatim with the REST profile's `KohakuHostDeps.fixation_admit`
    rather than being duplicated in both hosts' `fixation_lookup` implementations."""
    fixation_admit: (
        Callable[[FixationRecord, SessionContext], Awaitable[bool] | bool] | None
    ) = None
    """Delivery-admission gate consulted, when set, after a fixation is found via `fixation_lookup` and
    before it is checked for staleness (kohaku.host_core's `FixationDeliveryHost.admit`). See
    `fixation_lookup`'s doc — the same function can be shared with the REST profile's
    `KohakuHostDeps.fixation_admit`."""
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

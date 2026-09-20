"""Helpers shared by every route group (compose / binding / governance / promotions / fixations).

Split out of the former monolithic `_fastapi_routes.py` (see that module's docstring for why this package
performs real top-level imports of fastapi / starlette instead of TYPE_CHECKING-guarded ones). This module
holds the pieces that do not belong to any single route group: principal / tenant / session resolution, small
parsing helpers, the JSON response builders, and governance-plane authorization (require_governance) — used
by governance.py, promotions.py, and fixations.py.

The per-(loop, deps, key) serialization lock (`_get_lock` / `_locks`) used to be defined here but now lives in
`kohaku.host_core.keyed_mutex` (so `kohaku.host_mcp`'s fixation self-heal serialization can share the exact
same mechanism, mirroring TS's `@kohaku-ui/host-core` `createKeyedMutex`) — re-exported below under their
original names, unchanged, for every existing import site in this package (compose.py / promotions.py /
fixations.py / `_fastapi_routes.py`) and test (`fr._get_lock` / `fr._locks`).

The logger is defined here with an **explicit name** (`kohaku.host_rest._fastapi_routes`, not `__name__`)
so that every submodule's log records keep the same logger name as before the split — tests attach to it via
`caplog.at_level(..., logger="kohaku.host_rest._fastapi_routes")`.
"""

from __future__ import annotations

import inspect
import json
import logging
import re
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any, cast

from fastapi.responses import JSONResponse
from starlette.datastructures import Headers, MutableHeaders
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from kohaku.host_core import DEFAULT_CAPABILITY_TTL_SECONDS, TraceContext, get_lock
from kohaku.host_core import create_allowed_actions as _host_core_create_allowed_actions
from kohaku.host_core import fail_open as _host_core_fail_open
from kohaku.host_core import notify_hook as _host_core_notify_hook
from kohaku.host_core import parse_trace_context as _parse_trace_context
from kohaku.host_core.keyed_mutex import _locks as _locks
from kohaku.spec import Principal, SessionContext

from ..bodies import SessionBody
from ..deps import HostErrorInfo, KohakuHostDeps
from ..errors import error_body
from ..governance_policy import GovernanceOperation
from ..serialize import to_jsonable

# --- Constants ---------------------------------------------------------------

# Explicit name (not __name__): every submodule under _routes/ shares this logger so log records keep the
# same logger name as the pre-split monolithic module (tests match on it via caplog).
_LOGGER = logging.getLogger("kohaku.host_rest._fastapi_routes")

ANONYMOUS = Principal(id="demo-user", roles=["user"])

# Sourced from kohaku.host_core (single source of truth, shared with kohaku.host_mcp).
_DEFAULT_CAPABILITY_TTL = DEFAULT_CAPABILITY_TTL_SECONDS

# Default request-body size cap (bytes) applied by BodyLimitASGIMiddleware when a host does not override
# deps.max_body_bytes. Mirrors TS's packages/host-rest/src/routes.ts DEFAULT_MAX_BODY_BYTES (1 MiB): comfortable
# headroom for a real /compose or /events payload (an NL question or an Intent + params), while a request past
# it is almost certainly abuse or a client bug.
DEFAULT_MAX_BODY_BYTES = 1_048_576

# ISO8601 validation for since / until. Timestamps require a timezone (Z / ±hh:mm); a date alone is interpreted as UTC.
_ISO8601_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:\d{2}))?$"
)

# Re-exported under its original name (this module used to define _get_lock directly — see module docstring
# above) for backward compatibility with every existing import site (compose.py / promotions.py / fixations.py
# / _fastapi_routes.py) and test (fr._get_lock).
_get_lock = get_lock


def _promotion_key(tenant: str | None) -> str:
    return f"prom\x1f{tenant or ''}"


def _fixation_key(tenant: str | None, intent_hash: str) -> str:
    return f"fix\x1f{tenant or ''}\x1f{intent_hash}"


# --- Small helpers ------------------------------------------------------------


def _message(e: object) -> str:
    return str(e)


async def _resolve(value: object) -> Any:
    """Normalize both sync and async hook return values into something awaitable."""
    if inspect.isawaitable(value):
        return await value
    return value


# --- Per-request correlation id (ops) ----------------------------------------
# Port of TS routes/shared.ts's requestIdOf. Default: the inbound x-request-id header when present and
# well-formed, otherwise a fresh uuid4. Unlike the old on_error-gated _new_request_id, every request now gets
# one regardless of whether on_error is wired — it also drives the X-Request-Id response header (see
# _RequestIdASGIMiddleware below) and every error envelope's requestId.

_MAX_INBOUND_REQUEST_ID_LEN = 128
_PRINTABLE_ASCII_RE = re.compile(r"^[\x20-\x7e]+$")


def _sanitize_inbound_request_id(raw: str | None) -> str | None:
    """Validates/normalizes an inbound x-request-id header value. None (= mint a fresh id) when absent, empty
    after trimming, over length, or containing anything outside printable ASCII (so a client cannot inject
    control characters / newlines into logs via this header)."""
    if raw is None:
        return None
    trimmed = raw.strip()
    if not trimmed or len(trimmed) > _MAX_INBOUND_REQUEST_ID_LEN:
        return None
    if not _PRINTABLE_ASCII_RE.match(trimmed):
        return None
    return trimmed


def request_id_of(request: Request, deps: KohakuHostDeps) -> str:
    """Resolves (and memoizes on `request.state`) the per-request correlation id. Starlette's `Request.state`
    is backed by `scope["state"]` (a dict shared by the whole ASGI scope), so every `Request` instance built
    from the same scope — the middleware's own and the one FastAPI constructs for the route handler — observes
    the same memoized value; calling this more than once per request (e.g. once in the middleware, again
    inside a route handler) is therefore cheap and consistent."""
    cached = getattr(request.state, "request_id", None)
    if cached is not None:
        return cast(str, cached)
    if deps.request_id is not None:
        request_id = deps.request_id(request)
    else:
        request_id = _sanitize_inbound_request_id(request.headers.get("x-request-id")) or str(uuid.uuid4())
    request.state.request_id = request_id
    return request_id


def trace_context_of(request: Request) -> TraceContext | None:
    """Resolves the request's W3C trace context from the standard `traceparent` / `tracestate` request
    headers (https://www.w3.org/TR/trace-context/), via kohaku.host_core's shared parse_trace_context (also
    used by kohaku.host_mcp's `_meta.traceparent` counterpart). Fail-open / additive: None when the header
    is absent or not strictly W3C-formatted. Port note: see kohaku.host_core.trace_context's module
    docstring for why this has no ComposeOptions sink yet (same parity gap as correlation_id/request_id) --
    it is used only by report_host_error's `trace_context` (HostErrorInfo.trace_context) today. Not
    memoized (unlike request_id_of): header parsing is cheap and this is read at most once per request."""
    return _parse_trace_context(request.headers.get("traceparent"), request.headers.get("tracestate"))


class RequestIdASGIMiddleware:
    """Stamps `X-Request-Id` on every response of the mounted kohaku routes (ops). Port of TS routes.ts's
    `app.use("*", ...)` middleware.

    A **pure ASGI middleware** (implementing `__call__(scope, receive, send)` directly), not
    `starlette.middleware.base.BaseHTTPMiddleware`: BaseHTTPMiddleware wraps the whole request/response
    lifecycle and historically buffers/interferes with streaming responses, which would break
    /compose/stream's SSE response. This middleware instead wraps `send` to inject the header into the
    `http.response.start` ASGI message as it passes through, unbuffered — the response body (including a
    streamed one) is untouched.

    Scoped to `prefix` (checked against `scope["path"]`) rather than applying to the whole app, since
    `register_routes` mounts directly onto the caller's FastAPI app (unlike TS's `createKohakuRoutes`, which
    returns its own isolated Hono sub-app) — requests to routes the host added outside `prefix` pass straight
    through unmodified.
    """

    def __init__(self, app: ASGIApp, deps: KohakuHostDeps, prefix: str) -> None:
        self.app = app
        self.deps = deps
        self.prefix = prefix

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith(self.prefix):
            await self.app(scope, receive, send)
            return

        # Resolving here (before calling downstream) stashes the id in scope["state"], which Request.state
        # reads/writes on every subsequent Request(scope, ...) instantiation from this same scope (including
        # the one FastAPI builds for the route handler) — see request_id_of's docstring.
        request_id = request_id_of(Request(scope, receive=receive), self.deps)

        async def send_with_request_id(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers.append("x-request-id", request_id)
            await send(message)

        await self.app(scope, receive, send_with_request_id)


class BodyLimitASGIMiddleware:
    """Rejects an oversized request body with 413 before it reaches the mounted kohaku routes (ops). Port of
    TS routes.ts's `app.use("*", bodyLimit({ maxSize, onError }))` (Hono's bodyLimit middleware).

    A **pure ASGI middleware** (like RequestIdASGIMiddleware above), for the same streaming-safety reason:
    scoped to `prefix`, so it never touches a body the host handles outside the mounted routes.

    Two admission paths, matching Hono's bodyLimit behavior:
    - A well-formed `Content-Length` over the limit is rejected immediately, without reading any of the body
      off the wire.
    - Otherwise (no `Content-Length`, or one that doesn't parse as bytes — e.g. chunked transfer-encoding),
      the body is buffered chunk by chunk via `receive()` and rejected the moment the running total exceeds
      the limit, without ever forwarding a message to the downstream app. When the body turns out to be
      within the limit, the buffered `http.request` messages are replayed to the downstream app in order (via
      a wrapped `receive`) so it observes the exact same message sequence it would have without this
      middleware in front.

    The rejection response body is byte-identical to TS's `errorBody("BAD_REQUEST", "request body too
    large")`: `{"error":{"code":"BAD_REQUEST","message":"request body too large"}}` (no `requestId` — the
    same call site in TS passes none either, and this middleware runs before request_id_of has a chance to
    resolve one, mirroring Hono's `bodyLimit` running ahead of the request-id middleware in routes.ts).
    """

    def __init__(self, app: ASGIApp, deps: KohakuHostDeps, prefix: str) -> None:
        self.app = app
        self.deps = deps
        self.prefix = prefix

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith(self.prefix):
            await self.app(scope, receive, send)
            return

        max_bytes = (
            self.deps.max_body_bytes
            if self.deps.max_body_bytes is not None
            else DEFAULT_MAX_BODY_BYTES
        )

        declared = Headers(scope=scope).get("content-length")
        if declared is not None:
            try:
                declared_bytes = int(declared)
            except ValueError:
                declared_bytes = None
            if declared_bytes is not None and declared_bytes > max_bytes:
                await _send_body_too_large(send)
                return

        # No (usable) Content-Length: accumulate body chunks ourselves before handing anything to the
        # downstream app, so a chunked/streamed body that turns out to be oversized never reaches it.
        buffered: list[Message] = []
        total = 0
        more_body = True
        while more_body:
            message = await receive()
            buffered.append(message)
            if message["type"] != "http.request":
                # A non-body lifecycle message (e.g. http.disconnect) ends the loop; let the app (via the
                # replay receive below) see it directly rather than trying to size-check it.
                break
            total += len(message.get("body", b""))
            if total > max_bytes:
                await _send_body_too_large(send)
                return
            more_body = bool(message.get("more_body", False))

        queue = buffered

        async def replay_receive() -> Message:
            if queue:
                return queue.pop(0)
            return await receive()

        await self.app(scope, replay_receive, send)


async def _send_body_too_large(send: Send) -> None:
    body = json.dumps(error_body("BAD_REQUEST", "request body too large")).encode("utf-8")
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


async def report_host_error(
    deps: KohakuHostDeps,
    endpoint: str,
    request_id: str,
    error: object,
    *,
    trace_context: TraceContext | None = None,
) -> None:
    """Observability hook for the failure path. Silent if on_error is unwired. Swallows throws via
    kohaku.host_core.notify_hook (the shared swallow-on-throw building block, also consumed by kohaku.host_mcp).
    request_id is always the request's resolved correlation id (from request_id_of) — every request has one
    now, regardless of whether on_error is wired. `trace_context` (optional; see HostErrorInfo's doc
    comment) is passed only by the compose-path call sites today (mirroring kohaku.host_mcp's
    correlation_id/trace_context, which are likewise populated only from _safe_tool's except branch) —
    every other call site keeps reporting None, unchanged from before this parameter existed."""
    await _host_core_notify_hook(
        deps.on_error,
        HostErrorInfo(endpoint=endpoint, request_id=request_id, error=error, trace_context=trace_context),
    )


async def allowed_actions(deps: KohakuHostDeps) -> frozenset[str]:
    """Memoized `deps.domain.list_operations()` names, used to restrict issued capability write scopes
    (hardening against a hallucinated/injected action.invoke action name). Backed by host_core's
    `create_allowed_actions` (shared with the MCP profile so both agree on how a DomainPort's
    list_operations() names are cached and retried), built once per `deps` and cached on
    `deps._allowed_actions_fn` (list_operations is async and must not be re-awaited on every compose).

    Raises on failure rather than swallowing it: the caller (compose.py's issue_capability_for_spec) already
    knows the endpoint/request_id needed to report through on_error, so it catches this and falls back to an
    empty frozenset (fail-closed for writes; delivery still proceeds). Nothing is cached on failure, so the
    next call retries against the DomainPort.
    """
    if deps._allowed_actions_fn is None:
        deps._allowed_actions_fn = _host_core_create_allowed_actions(deps.domain)
    return await deps._allowed_actions_fn()


async def safe_record(
    deps: KohakuHostDeps,
    endpoint: str,
    request_id: str,
    record: Callable[[], Awaitable[None]],
) -> None:
    """Run the audit record fail-open via kohaku.host_core.fail_open (the shared fail-open building block).
    Failures are reported to on_error and do not drag down delivery."""
    await _host_core_fail_open(record, lambda e: report_host_error(deps, endpoint, request_id, e))


def _bearer_token(request: Request) -> str | None:
    header = request.headers.get("authorization")
    if header is None or not header.lower().startswith("bearer "):
        return None
    return header[7:].strip()


async def _get_principal(deps: KohakuHostDeps, request: Request) -> Principal:
    if deps.auth is None:
        return ANONYMOUS
    result = await _resolve(deps.auth(request))
    return result if result is not None else ANONYMOUS


async def _resolve_tenant(deps: KohakuHostDeps, request: Request) -> str | None:
    if deps.tenant is None:
        return None
    result = await _resolve(deps.tenant(request))
    return result if result is not None else None


def to_session(session: SessionBody, principal: Principal, tenant: str | None) -> SessionContext:
    return SessionContext(
        surface=session.surface,
        sessionId=session.session_id,
        principal=principal,
        locale=session.locale,
        tenant=tenant,
    )


def parse_iso8601(raw: str) -> str | None:
    """Validate ISO8601 and canonicalize to the JS toISOString form (UTC, 3-digit ms, trailing Z). None if invalid."""
    if not _ISO8601_PATTERN.match(raw):
        return None
    try:
        if "T" not in raw and "t" not in raw:
            dt = datetime.fromisoformat(raw).replace(tzinfo=UTC)
        else:
            normalized = raw.replace("Z", "+00:00").replace("z", "+00:00")
            dt = datetime.fromisoformat(normalized)
            if dt.tzinfo is None:
                return None
        dt = dt.astimezone(UTC)
    except ValueError:
        return None
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


# Only a plain decimal-digit string (with an optional decimal point) is accepted -- unlike a bare
# `float(raw)` conversion, this rejects underscore digit-group separators ("1_000") and scientific
# notation ("1e3"), both of which Python's float() would otherwise silently accept as a value (unlike
# JS's Number(), which accepts hex ("0x10") instead). This is the isomorphic parity fix for the TS
# implementation's parseLimit (packages/host-rest/src/routes/governance.ts).
_LIMIT_PATTERN = re.compile(r"^\d+(\.\d+)?$")


def _parse_limit(raw: str | None, max_limit: int, default: int | None) -> int | None:
    """Validate limit (only a decimal-digit string is accepted; matches the TS implementation's
    parseLimit). Rejects NaN / negative / non-decimal-digit-string / oversized values. Invalid or
    unspecified defers to default."""
    if raw is None or not _LIMIT_PATTERN.fullmatch(raw):
        return default
    n = float(raw)
    if n <= 0:
        return default
    return min(int(n), max_limit)


# --- JSON response helpers ----------------------------------------------------


def _json(body: object, status: int = 200) -> Response:
    return JSONResponse(content=to_jsonable(body), status_code=status)


def _error(code: Any, message: str, status: int, request_id: str | None = None) -> Response:
    return JSONResponse(content=error_body(code, message, request_id), status_code=status)


async def _read_json(request: Request) -> Any:
    raw = await request.body()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return None


# --- Governance/audit-plane authorization --------------------------------


async def require_governance(
    deps: KohakuHostDeps, request: Request, operation: GovernanceOperation
) -> Response | None:
    """Governance/audit plane authorization. None (allowed) if unwired. Denial is 403 CAPABILITY_DENIED."""
    if deps.authorize_governance is None:
        return None
    principal = await _get_principal(deps, request)
    tenant = await _resolve_tenant(deps, request)
    allowed = await _resolve(deps.authorize_governance(principal, operation, tenant))
    if allowed:
        return None
    return _error(
        "CAPABILITY_DENIED", f'governance operation "{operation.kind}" was not authorized', 403
    )

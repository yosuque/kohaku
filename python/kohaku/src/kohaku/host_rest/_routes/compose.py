"""Compose route group: /intent/normalize, /compose, /compose/stream, /events.

Split out of the former monolithic `_fastapi_routes.py` to mirror packages/host-rest/src/routes/compose.ts.
Also home to the fixation short-circuit (compose_with_fixation / settle_fixation), client-disconnect abort
propagation (_disconnect_abort), and the SSE machinery for /compose/stream — all of it is either used
only by this group's routes or (compose_with_fixation) re-used by fixations.py's /fixations/approve.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable, Sequence
from typing import Any

from fastapi import APIRouter
from starlette.requests import Request
from starlette.responses import Response, StreamingResponse

from kohaku.composer import ComposeOptions, ComposeResult, IntentComposeInput, compose_stream
from kohaku.composer.compose_stream import StreamPatchEvent, StreamSpecEvent
from kohaku.composer.fixation import FixationCheck
from kohaku.host_core import (
    ComposeFixationContext,
    FixationDeliveryHost,
    FixationTarget,
    is_typed_host_error,
)
from kohaku.host_core import WriteScopeDroppedError as _WriteScopeDroppedError
from kohaku.host_core import compose_with_fixation as _host_core_compose_with_fixation
from kohaku.host_core import issue_capability_for_spec as _host_core_issue_capability_for_spec
from kohaku.host_core import resolve_fixated_result as _host_core_resolve_fixated_result
from kohaku.host_core import settle_fixation as _host_core_settle_fixation
from kohaku.llm import AbortController, AbortError, AbortSignal
from kohaku.spec import (
    FixationRecord,
    GuiAction,
    Intent,
    IntentInput,
    Principal,
    Scope,
    SessionContext,
    UISpec,
    compute_spec_hash,
    finalize_intent,
)

from ..bodies import ComposeBody, parse_compose_body, parse_events_body
from ..deps import KohakuHostDeps
from ..errors import error_body
from .shared import (
    _DEFAULT_CAPABILITY_TTL,
    _error,
    _fixation_key,
    _get_lock,
    _get_principal,
    _json,
    _message,
    _read_json,
    _resolve_tenant,
    allowed_actions,
    report_host_error,
    request_id_of,
    safe_record,
    to_session,
    trace_context_of,
)

# Emission interval (seconds) of the SSE heartbeat (comment line). Same value as TS SSE_HEARTBEAT_INTERVAL_MS=15000.
# Kept shorter than LB / reverse-proxy idle timeouts (around 60s) to prevent disconnection during long silent
# intervals while generating.
SSE_HEARTBEAT_INTERVAL_S = 15.0

# The client-visible message for an untyped composition failure (COMPOSE_FAILED). An arbitrary exception (a
# downstream library failure, an unexpected bug) may carry internals unsafe to echo back, so only a "typed"
# host error (SpecError/ComposeError — see kohaku.host_core.is_typed_host_error) has its own message pass
# through; anything else collapses to this fixed text. The original error still reaches the observability
# hook (on_error) via report_host_error, so nothing is lost for diagnosis. Port of TS compose.ts's
# COMPOSE_FAILED_MESSAGE.
_COMPOSE_FAILED_MESSAGE = "composition failed; see the observability hook (on_error) for details"

# The client-visible message for an untyped Intent-resolution failure (INTENT_INVALID). Same rationale as
# _COMPOSE_FAILED_MESSAGE above: a raw exception's message may leak internals, so it collapses to this fixed
# text unless it is a "typed" host error (see is_typed_host_error), whose own message is safe to pass
# through. The original error still reaches the observability hook (on_error) via report_host_error. Port of
# TS compose.ts's INTENT_INVALID_MESSAGE.
_INTENT_INVALID_MESSAGE = "intent normalization failed; see the observability hook (on_error) for details"


# --- capability issuance ------------------------------------------------------


async def issue_capability_for_spec(
    spec: UISpec,
    principal: Principal,
    deps: KohakuHostDeps,
    endpoint: str,
    request_id: str,
) -> str:
    """Issue a capability matching the Spec's declarations (read: $ref + bind variant / write: action).

    The issuance rule itself lives in kohaku.host_core.issue_capability_for_spec (which in turn consumes the
    spec-layer collect_capability_scopes, the single source of truth), shared with the MCP surface's
    _issue_capability so both profiles agree on the issuance rule.

    Write scopes are additionally restricted to the DomainPort's list_operations() names (hardening against a
    hallucinated/injected action.invoke action name becoming a bearer write scope): the allowed set is
    memoized per deps (list_operations is async and must not be awaited on every compose; see
    shared.allowed_actions), and a dropped action is reported via the endpoint's on_error hook as a
    WriteScopeDroppedError. If list_operations itself rejects, the capability is still issued but
    fail-closed for writes (an empty allowed set), and the rejection is reported the same way; delivery
    proceeds either way.
    """
    try:
        allowed = await allowed_actions(deps)
    except Exception as e:  # noqa: BLE001 — reported, then fail-closed for writes (delivery still proceeds)
        await report_host_error(deps, endpoint, request_id, e)
        allowed = frozenset()

    # on_dropped_action (kohaku.host_core's contract) is synchronous, so dropped action names are collected
    # here and reported with a real await afterward, rather than firing an unawaited task per drop.
    dropped: list[str] = []
    token = await _host_core_issue_capability_for_spec(
        deps.authz,
        principal,
        spec,
        deps.capability_ttl_seconds
        if deps.capability_ttl_seconds is not None
        else _DEFAULT_CAPABILITY_TTL,
        allowed_actions=allowed,
        on_dropped_action=dropped.append,
    )
    for action in dropped:
        await report_host_error(deps, endpoint, request_id, _WriteScopeDroppedError(action))
    return token


async def issue_capability_for_refs(
    principal: Principal, refs: Sequence[str], deps: KohakuHostDeps
) -> str:
    """Issue a read capability covering the resolved QueryHandle URIs (for the streaming skeleton)."""
    unique = list(dict.fromkeys(refs))
    scopes = [Scope(kind="read", ref=ref) for ref in unique]
    return await deps.authz.issue_capability(
        principal,
        scopes,
        ttl_seconds=deps.capability_ttl_seconds
        if deps.capability_ttl_seconds is not None
        else _DEFAULT_CAPABILITY_TTL,
    )


# --- Client-disconnect abort propagation --------------------------------

# Disconnect polling interval (seconds). starlette has no synthesis-free signal equivalent to Hono's
# c.req.raw.signal, so request.is_disconnected() is polled periodically and converted into an AbortSignal (TS: c.req.raw.signal).
_DISCONNECT_POLL_INTERVAL_S = 0.25


@contextlib.asynccontextmanager
async def _disconnect_abort(
    request: Request, *, poll_interval_s: float = _DISCONNECT_POLL_INTERVAL_S
) -> AsyncIterator[AbortSignal]:
    """A monitored context that periodically polls for the request disconnecting and supplies an AbortSignal that fires on disconnect.

    On leaving the context (whether on normal completion, disconnect, or exception) the monitor task is always cleaned
    up. Generation runs under the shared signal, so a disconnect rides the #17 abort quorum (single-flight quorum, compose.py).
    poll_interval_s is injectable from tests.
    """
    controller = AbortController()

    async def _monitor() -> None:
        try:
            while True:
                if await request.is_disconnected():
                    controller.abort(AbortError("Client disconnected"))
                    return
                await asyncio.sleep(poll_interval_s)
        except asyncio.CancelledError:
            raise

    task = asyncio.ensure_future(_monitor())
    try:
        yield controller.signal
    finally:
        task.cancel()
        # Clean up the monitor task (swallow the cancel's CancelledError and any unexpected exception from is_disconnected).
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task


# --- compose short-circuit (fixation) -----------------------------------------


def _fixation_host(deps: KohakuHostDeps, request_id: str | None) -> FixationDeliveryHost:
    """Adapts a REST KohakuHostDeps into the FixationDeliveryHost surface kohaku.host_core's fixation helpers
    consume. run_self_heal awaits the self-heal call under the per-(tenant, intentHash) fixation lock
    (_run_fixation_selfheal, unchanged) — matching pre-extraction REST behavior exactly (the self-heal call is
    fully awaited before compose_with_fixation/settle_fixation return, unlike the MCP profile's fire-and-forget).
    `kind` is mapped to REST's own (pre-existing) endpoint-string convention.

    request_id is the originating request's correlation id (ops), threaded through so a self-heal failure
    reported via report_host_error can be tied back to the request that triggered it — a fresh
    FixationDeliveryHost is built per call (unlike TS's per-deps cache), so this is a plain parameter rather
    than needing to be threaded through a cache lookup. When omitted (e.g. a direct caller of
    compose_with_fixation outside a request, such as a test), a fresh id is minted per self-heal call,
    mirroring TS's onSelfHealError randomUUID() fallback.
    """

    async def _run_self_heal(
        tenant: str | None,
        intent_hash: str,
        fn: Callable[[], Awaitable[None]],
        kind: Any,
    ) -> None:
        endpoint = (
            "fixation.refresh_fingerprint" if kind == "refresh_fingerprint" else "fixation.invalidate"
        )
        await _run_fixation_selfheal(
            deps, tenant, intent_hash, fn, endpoint, request_id or str(uuid.uuid4())
        )

    return FixationDeliveryHost(
        run_self_heal=_run_self_heal,
        lookup=deps.fixation_lookup,
        admit=deps.fixation_admit,
        fixations=deps.fixations,
    )


async def resolve_fixated_result(
    intent: Intent, session: SessionContext, deps: KohakuHostDeps, request_id: str | None = None
) -> ComposeResult | None:
    """Resolve the L0 fixation shortcut, delegating the materialize/settle sequence to kohaku.host_core (shared
    with kohaku.host_mcp). Revalidation uses the tenant's catalog.
    """
    return await _host_core_resolve_fixated_result(
        intent,
        session,
        deps.compose.with_tenant_catalog(session.tenant),
        _fixation_host(deps, request_id),
    )


async def compose_with_fixation(
    intent: Intent,
    session: SessionContext,
    deps: KohakuHostDeps,
    *,
    request_id: str | None = None,
    abort: AbortSignal | None = None,
) -> ComposeResult:
    """Look up the L0 fixation and return it if deliverable, otherwise return a normal compose (stale / unwired).

    materialize validates against the tenant catalog; the normal-compose fallback runs against the untenanted
    deps.compose (compose() re-applies tenant/session internally, as before extraction). Every REST route
    handler passes its own resolved request_id; it is optional here only for direct callers outside a request
    (see _fixation_host's docstring).
    """
    return await _host_core_compose_with_fixation(
        intent,
        session,
        ComposeFixationContext(
            materialize=deps.compose.with_tenant_catalog(session.tenant),
            compose=deps.compose,
            abort=abort,
        ),
        _fixation_host(deps, request_id),
    )


async def settle_fixation(
    materialized: tuple[ComposeResult | None, FixationCheck],
    intent: Intent,
    session: SessionContext,
    deps: KohakuHostDeps,
    fixation: FixationRecord,
    request_id: str | None = None,
) -> ComposeResult | None:
    """Decide deliverability from materialize's staleness check and run self-healing as a side effect.

    Thin wrapper kept for backward-compatible re-export (_fastapi_routes.settle_fixation); the sequencing logic
    itself lives in kohaku.host_core.settle_fixation, shared with kohaku.host_mcp.
    """
    return await _host_core_settle_fixation(
        materialized,
        FixationTarget(
            intent_hash=intent.hash,
            tenant=session.tenant,
            catalog_fingerprint=deps.compose.with_tenant_catalog(session.tenant).catalog.fingerprint,
            fixation=fixation,
        ),
        _fixation_host(deps, request_id),
    )


async def _run_fixation_selfheal(
    deps: KohakuHostDeps,
    tenant: str | None,
    intent_hash: str,
    fn: Callable[[], Awaitable[None]],
    endpoint: str,
    request_id: str,
) -> None:
    """Self-healing (the same (tenant, intentHash) lock as fixate / unfixate). Failures are reported to on_error."""
    async with _get_lock(deps, _fixation_key(tenant, intent_hash)):
        try:
            await fn()
        except BaseException as e:
            await report_host_error(deps, endpoint, request_id, e)


# --- Recording (fail-open) -----------------------------------------------------


async def record_fallback_if_any(
    result: ComposeResult, session: SessionContext, deps: KohakuHostDeps
) -> None:
    """Record view.fallback when the spec includes a fallback (the source of truth is spec.provenance.fallback)."""
    fallback = result.spec.provenance.fallback
    if fallback is None:
        return
    if deps.recorder is not None:
        await deps.recorder.fallback(
            spec=result.spec,
            reason=fallback.reason,
            kind=fallback.kind if fallback.kind is not None else "generation",
            surface=session.surface,
            session_id=session.sessionId,
            tenant=session.tenant,
        )


async def _record_composed(
    deps: KohakuHostDeps,
    result: ComposeResult,
    session: SessionContext,
    spec_hash: str | None = None,
) -> None:
    if deps.recorder is not None:
        await deps.recorder.composed(
            spec=result.spec,
            trace=result.trace,
            surface=session.surface,
            session_id=session.sessionId,
            tenant=session.tenant,
            spec_hash=spec_hash,
        )
    await record_fallback_if_any(result, session, deps)


async def resolve_intent_from_body(
    body: ComposeBody, session: SessionContext, deps: KohakuHostDeps
) -> Intent:
    """Resolve an Intent from a ComposeBody. If body.intent exists, finalize it; otherwise normalize -> finalize."""
    if body.intent is not None:
        return finalize_intent(body.intent)
    assert body.input is not None
    normalized = await deps.compose.semantic.normalize(body.input, session)
    return finalize_intent(normalized)


# --- SSE helpers ----------------------------------------------------------------


def _sse(event: str, data: dict[str, Any]) -> str:
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return f"event: {event}\ndata: {payload}\n\n"


async def _finish_stream_record(
    deps: KohakuHostDeps, result: ComposeResult, session: SessionContext, request_id: str
) -> dict[str, Any]:
    """Record lineage exactly once for the final Spec and return the data for the done event."""
    spec_hash = compute_spec_hash(result.spec)

    async def _rec() -> None:
        await _record_composed(deps, result, session, spec_hash)

    # Same cancelled-skip as /compose: a client disconnect/timeout must not inflate view.composed /
    # view.fallback counts, and observer.onError already received phase="cancelled" from the composer.
    if not result.trace.cancelled:
        await safe_record(deps, "compose/stream", request_id, _rec)
    return {
        "specHash": spec_hash,
        "tier": result.spec.provenance.tier,
        "cache": result.spec.provenance.cache,
    }


async def _compose_stream_body(
    deps: KohakuHostDeps,
    intent: Intent,
    session: SessionContext,
    principal: Principal,
    request_id: str,
    abort: AbortSignal | None = None,
) -> AsyncGenerator[str, None]:
    """The SSE event sequence for /compose/stream (event: spec -> patch* -> exactly one done / error).

    The keepalive heartbeat is not overlaid here (_with_heartbeat handles it). The body always terminates,
    mapping failures into an error event via its own try/except.
    """
    try:
        # resolve_fixated_result = the single source of truth shared with compose_with_fixation. On hit, a
        # single final:true event + done. No fixation / stale returns None = fall through to the streaming
        # generation path below.
        result = await resolve_fixated_result(intent, session, deps, request_id)
        if result is not None:
            capability = await issue_capability_for_spec(
                result.spec, principal, deps, "compose/stream", request_id
            )
            yield _sse(
                "spec",
                {"spec": result.spec.to_wire(), "capability": capability, "final": True},
            )
            yield _sse("done", await _finish_stream_record(deps, result, session, request_id))
            return

        # final:true (cache hit / L0 fixed Spec — compose_stream can complete in a single event without ever
        # emitting a skeleton) is issued from the Spec itself, via the same issue_capability_for_spec wrapper
        # as the fixation shortcut above: collect_capability_scopes covers both the $ref/bind-variant read
        # scopes and any action.invoke write scope the final Spec declares, and enforces MAX_BIND_VARIANTS (an
        # overflow raises into the except below -> event: error COMPOSE_FAILED). A final Spec can declare
        # action.invoke (e.g. presentForm submit) — without this, that write scope was previously never issued
        # and /binding/action always 403'd for a stream-delivered final Spec.
        #
        # final:false (the skeleton) has no $ref yet, so it is issued read-only from compose_stream's resolved
        # refs instead (issue_capability_for_refs). bind (two-way binding, [Draft]) is declared only on the
        # final Spec and is not opened up to L1/L2 generation, so a skeleton never needs bind variants;
        # consequently an L1/L2-generated Spec delivered via patches after this skeleton carries no write
        # scope either (documented limitation — only a single-event final:true response can carry
        # action.invoke over the stream).
        capability_ref: str | None = None
        final: ComposeResult | None = None
        stream_input = IntentComposeInput(
            intent=IntentInput(canonical=intent.canonical, params=intent.params)
        )
        async for ev in compose_stream(
            stream_input, deps.compose, ComposeOptions(session=session, abort=abort)
        ):
            if isinstance(ev, StreamSpecEvent):
                if capability_ref is None:
                    capability_ref = (
                        await issue_capability_for_spec(
                            ev.spec, principal, deps, "compose/stream", request_id
                        )
                        if ev.final
                        else await issue_capability_for_refs(principal, list(ev.refs), deps)
                    )
                yield _sse(
                    "spec",
                    {"spec": ev.spec.to_wire(), "capability": capability_ref, "final": ev.final},
                )
            elif isinstance(ev, StreamPatchEvent):
                yield _sse("patch", {"patch": ev.patch.to_wire()})
            else:
                final = ev.result
        if final is not None:
            yield _sse("done", await _finish_stream_record(deps, final, session, request_id))
    except Exception as e:
        # CancelledError / GeneratorExit descend directly from BaseException and are not caught here.
        # A client disconnect / request timeout surfaces here too (abort.aborted). That is not a generation
        # failure: reporting it to on_error would inflate failure metrics with routine disconnects, and
        # yielding a further SSE event onto an already-abandoned generator serves no reader — skip both and
        # let the generator end (mirrors the TS reference implementation's
        # packages/host-rest/src/routes/compose.ts catch(e) abort.aborted guard).
        if abort is not None and abort.aborted:
            return
        await report_host_error(deps, "compose/stream", request_id, e)
        client_message = _message(e) if is_typed_host_error(e) else _COMPOSE_FAILED_MESSAGE
        yield _sse("error", error_body("COMPOSE_FAILED", client_message, request_id))


def _intent_invalid(e: BaseException, request_id: str) -> Response:
    """Map an Intent-resolution failure to the INTENT_INVALID 422 response body.

    Shared by /intent/normalize, /compose, /compose/stream and /events: all four call this with the same
    two-line mapping (typed host errors pass their own message through; anything else collapses to
    _INTENT_INVALID_MESSAGE). Reporting the error to the observability hook (report_host_error, endpoint- and
    trace-context-specific per call site) stays the caller's responsibility — this helper only builds the
    response.
    """
    client_message = _message(e) if is_typed_host_error(e) else _INTENT_INVALID_MESSAGE
    return _error("INTENT_INVALID", client_message, 422, request_id)


async def _deliver_composed(
    request: Request,
    deps: KohakuHostDeps,
    intent: Intent,
    session: SessionContext,
    principal: Principal,
    request_id: str,
    endpoint: str,
    *,
    pre_record: Callable[[], Awaitable[None]] | None = None,
) -> Response:
    """Shared compose-and-respond sequence for /compose and /events: disconnect-abort monitoring ->
    compose_with_fixation -> issue_capability_for_spec -> cancelled-aware lineage recording -> the same
    COMPOSE_FAILED except mapping.

    endpoint is the (pre-existing) REST endpoint string ("compose" / "events") recorded into
    issue_capability_for_spec's on_dropped_action report, safe_record's lineage entry and report_host_error's
    observability hook alike — /compose and /events already agreed on using their own route name for all
    three, so a single parameter covers it.

    pre_record, when given, runs before _record_composed inside the same cancelled-aware safe_record callback
    (only /events needs this, to record the interaction itself via deps.recorder.interacted before recording
    the resulting Spec — /compose has no such step).
    """
    try:
        # Monitor for client disconnect and, on disconnect, vote to abort generation (single-flight quorum).
        async with _disconnect_abort(request) as abort:
            result = await compose_with_fixation(intent, session, deps, abort=abort, request_id=request_id)
            capability = await issue_capability_for_spec(result.spec, principal, deps, endpoint, request_id)

            async def _rec() -> None:
                if pre_record is not None:
                    await pre_record()
                await _record_composed(deps, result, session)

            # A cancelled compose (the caller's abort fired) is not a generation failure and
            # observer.onError already received phase="cancelled" from the composer — skip lineage
            # recording entirely so a client disconnect/timeout does not inflate view.composed /
            # view.fallback counts. The fallback body is still returned as usual.
            if not result.trace.cancelled:
                await safe_record(deps, endpoint, request_id, _rec)
            return _json({"spec": result.spec.to_wire(), "capability": capability})
    except BaseException as e:
        await report_host_error(deps, endpoint, request_id, e, trace_context=trace_context_of(request))
        # An arbitrary exception's message never reaches the client (it may leak internals); a typed host
        # error (SpecError/ComposeError) still passes its own message through.
        client_message = _message(e) if is_typed_host_error(e) else _COMPOSE_FAILED_MESSAGE
        return _error("COMPOSE_FAILED", client_message, 500, request_id)


# Sentinel marking generation completion (the end of the queue; the signal to stop keepalive).
_STREAM_SENTINEL = object()


async def _with_heartbeat(body: AsyncIterator[str], interval_s: float) -> AsyncIterator[str]:
    """Overlay a keepalive comment line (`: keepalive`) onto any SSE body iterator.

    Implements the setInterval equivalent of the TS reference (the heartbeat inside
    `deliverComposedStream` in packages/host-rest/src/routes/compose.ts) with asyncio.
    Runs the generation body (_compose_stream_body) and keepalive concurrently, sending keepalive to keep the
    connection alive while the body sends nothing for interval_s seconds. The client's SSE parser ignores comment
    lines (leading ":"). On body completion (sentinel) keepalive stops and the generation task is cleaned up. The
    interval is injectable from tests.
    """
    queue: asyncio.Queue[Any] = asyncio.Queue()
    error: list[BaseException] = []

    async def _produce() -> None:
        try:
            async for chunk in body:
                await queue.put(chunk)
        except BaseException as e:  # noqa: BLE001 — carry the body exception to the main loop and re-raise after terminating
            error.append(e)
        finally:
            await queue.put(_STREAM_SENTINEL)

    producer = asyncio.ensure_future(_produce())
    # The getter is not cancelled on timeout (it is kept and re-awaited on the next iteration). This avoids the
    # "dropped right after taking it off the queue on timeout" race.
    getter: asyncio.Future[Any] | None = None
    try:
        while True:
            if getter is None:
                getter = asyncio.ensure_future(queue.get())
            done, _pending = await asyncio.wait({getter}, timeout=interval_s)
            if getter in done:
                item = getter.result()
                getter = None
                if item is _STREAM_SENTINEL:
                    break  # generation complete -> stop keepalive
                yield item
            else:
                yield ": keepalive\n\n"
    finally:
        if getter is not None:
            getter.cancel()
        producer.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await producer
    if error:
        raise error[0]


async def _compose_stream_events(
    deps: KohakuHostDeps,
    intent: Intent,
    session: SessionContext,
    principal: Principal,
    request_id: str,
    request: Request,
    heartbeat_interval_s: float | None = None,
) -> AsyncIterator[str]:
    """The final stream that overlays the keepalive heartbeat onto the /compose/stream SSE event sequence.

    Omitting heartbeat_interval_s uses the module constant SSE_HEARTBEAT_INTERVAL_S (15s, the same value as TS).
    """
    interval = SSE_HEARTBEAT_INTERVAL_S if heartbeat_interval_s is None else heartbeat_interval_s
    # Disconnect monitoring runs across the whole stream (body + keepalive) and votes to abort generation on exit.
    # When the generator is aclose'd (disconnect), __aexit__ cleans up the monitor task.
    async with _disconnect_abort(request) as abort:
        body = _compose_stream_body(deps, intent, session, principal, request_id, abort)
        async for chunk in _with_heartbeat(body, interval):
            yield chunk


# --- Route registration ---------------------------------------------------------


def register_compose_routes(router: APIRouter, deps: KohakuHostDeps) -> None:
    """Registers /intent/normalize, /compose, /compose/stream, /events onto router."""

    # --- Intent normalization -----------------------------------------------
    @router.post("/intent/normalize")
    async def intent_normalize(request: Request) -> Response:
        request_id = request_id_of(request, deps)
        body = parse_compose_body(await _read_json(request))
        if body is None or body.input is None:
            return _error("BAD_REQUEST", "input (NLQuery | GuiAction) is required", 400)
        session = to_session(
            body.session, await _get_principal(deps, request), await _resolve_tenant(deps, request)
        )
        try:
            normalized = await deps.compose.semantic.normalize(body.input, session)
            intent = finalize_intent(normalized)
            source = "llm" if body.input.kind == "nl" else "deterministic"
            return _json({"intent": intent.to_wire(), "source": source})
        except BaseException as e:
            await report_host_error(
                deps, "intent/normalize", request_id, e, trace_context=trace_context_of(request)
            )
            return _intent_invalid(e, request_id)

    # --- Compose ------------------------------------------------------------
    @router.post("/compose")
    async def compose_route(request: Request) -> Response:
        request_id = request_id_of(request, deps)
        body = parse_compose_body(await _read_json(request))
        if body is None or (body.input is None and body.intent is None):
            return _error("BAD_REQUEST", "either input or intent is required", 400)
        principal = await _get_principal(deps, request)
        session = to_session(body.session, principal, await _resolve_tenant(deps, request))
        try:
            intent = await resolve_intent_from_body(body, session, deps)
        except BaseException as e:
            await report_host_error(deps, "compose", request_id, e, trace_context=trace_context_of(request))
            return _intent_invalid(e, request_id)
        return await _deliver_composed(request, deps, intent, session, principal, request_id, "compose")

    # --- Compose streaming (SSE) --------------------------------------------
    @router.post("/compose/stream")
    async def compose_stream_route(request: Request) -> Response:
        request_id = request_id_of(request, deps)
        body = parse_compose_body(await _read_json(request))
        if body is None or (body.input is None and body.intent is None):
            return _error("BAD_REQUEST", "either input or intent is required", 400)
        principal = await _get_principal(deps, request)
        session = to_session(body.session, principal, await _resolve_tenant(deps, request))
        try:
            intent = await resolve_intent_from_body(body, session, deps)
        except BaseException as e:
            await report_host_error(
                deps, "compose/stream", request_id, e, trace_context=trace_context_of(request)
            )
            return _intent_invalid(e, request_id)
        return StreamingResponse(
            _compose_stream_events(deps, intent, session, principal, request_id, request),
            media_type="text/event-stream",
        )

    # --- Interaction loop ---------------------------------------------------
    @router.post("/events")
    async def events_route(request: Request) -> Response:
        request_id = request_id_of(request, deps)
        body = parse_events_body(await _read_json(request))
        if body is None:
            return _error("BAD_REQUEST", "intent and event are required", 400)
        if "." not in body.event.on:
            return _error("BAD_REQUEST", 'event.on must be "<componentId>.<event>"', 400)
        principal = await _get_principal(deps, request)
        session = to_session(body.session, principal, await _resolve_tenant(deps, request))
        try:
            current = finalize_intent(body.intent)
            normalized = await deps.compose.semantic.normalize(
                GuiAction(
                    kind="gui",
                    action=body.event.on,
                    params=body.event.payload,
                    current=current,
                ),
                session,
            )
            intent = finalize_intent(normalized)
        except BaseException as e:
            await report_host_error(deps, "events", request_id, e, trace_context=trace_context_of(request))
            return _intent_invalid(e, request_id)

        async def _record_interaction() -> None:
            if deps.recorder is not None:
                await deps.recorder.interacted(
                    intent_hash=current.hash,
                    component_id=body.event.on.split(".")[0],
                    on=body.event.on,
                    payload=body.event.payload,
                    surface=session.surface,
                    session_id=session.sessionId,
                    tenant=session.tenant,
                )

        return await _deliver_composed(
            request,
            deps,
            intent,
            session,
            principal,
            request_id,
            "events",
            pre_record=_record_interaction,
        )

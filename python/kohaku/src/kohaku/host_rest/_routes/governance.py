"""Governance/audit route group: /lineage, /analytics/summary, /telemetry.

Split out of the former monolithic `_fastapi_routes.py` to mirror packages/host-rest/src/routes/governance.ts.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from starlette.requests import Request
from starlette.responses import Response

from kohaku.spec import (
    APPROVAL_ISSUE_ERROR_CODE,
    LineageCursorError,
    LineageEventRecord,
    LineageFilter,
    LineagePageRequest,
)

from ..bodies import RenderedEvent, parse_approval_request_body, parse_telemetry_body
from ..deps import AnalyticsWindow, KohakuHostDeps
from ..governance_policy import GovernanceOperation
from .shared import (
    _error,
    _get_principal,
    _json,
    _message,
    _parse_limit,
    _read_json,
    _resolve_tenant,
    parse_iso8601,
    report_host_error,
    request_id_of,
    require_governance,
)

# The client-visible message for an unexpected ApprovalPort.issue_approval failure (INTERNAL 500). An
# arbitrary port error (a store/DB failure, say) may carry internals, so only an exception the port marked as
# client-caused (APPROVAL_ISSUE_ERROR_CODE) has its own message shown; the original still reaches the
# observability hook via report_host_error.
_APPROVAL_INTERNAL_ERROR_MESSAGE = "approval issuance failed; see the observability hook (on_error) for details"

# Aggregation window for usage analytics. Default 200 / max 1000 (aligned with the /lineage window constraint).
ANALYTICS_DEFAULT_LIMIT = 200
ANALYTICS_MAX_LIMIT = 1000


def register_governance_routes(router: APIRouter, deps: KohakuHostDeps) -> None:
    """Registers /lineage, /analytics/summary, /telemetry onto router."""

    # --- View Lineage reads (audit plane) -----------------------------------
    @router.get("/lineage")
    async def lineage_route(request: Request) -> Response:
        denied = await require_governance(deps, request, GovernanceOperation(kind="lineage.read"))
        if denied is not None:
            return denied
        q = request.query_params
        type_ = q.get("type")
        limit = _parse_limit(q.get("limit"), 1000, None)
        types = [s.strip() for s in type_.split(",") if s.strip()] if type_ is not None else []
        since_raw = q.get("since")
        since = parse_iso8601(since_raw) if since_raw is not None else None
        if since_raw is not None and since is None:
            return _error("BAD_REQUEST", "since must be an ISO8601 timestamp", 400)
        # until is canonicalized with the same helper (parse_iso8601) as /analytics/summary and passed to
        # LineageFilter.until with the same boundary interpretation (readability-6).
        until_raw = q.get("until")
        until = parse_iso8601(until_raw) if until_raw is not None else None
        if until_raw is not None and until is None:
            return _error("BAD_REQUEST", "until must be an ISO8601 timestamp", 400)
        tenant = await _resolve_tenant(deps, request)
        # Shared by both the default (tail-window) and order=asc (forward-paging) reads below; design.md #53.
        filter_kwargs: dict[str, Any] = {
            "type": types if types else None,
            "intentHash": q.get("intentHash"),
            "artifactId": q.get("artifactId"),
            "specHash": q.get("specHash"),
            "correlationId": q.get("correlationId"),
            "since": since,
            "until": until,
            "tenant": tenant,
        }

        order = q.get("order")
        if order is not None:
            # order=asc (design.md #53): forward, append-order paging via StoragePort.page_lineage instead
            # of the default tail window below. Any other order value is a client error (only "asc" is
            # defined); leaving `order` unset entirely keeps the pre-existing response shape and behavior
            # unchanged.
            if order != "asc":
                return _error("BAD_REQUEST", 'order must be "asc"', 400)
            # page_lineage is a genuinely optional StoragePort extension (see kohaku.spec.ports.StoragePort's
            # comment on it) -- checked with hasattr, not isinstance (unlike put_promotion_states).
            if not hasattr(deps.compose.storage, "page_lineage"):
                return _error(
                    "NOT_IMPLEMENTED",
                    "forward paging (order=asc) is not supported by this storage backend",
                    501,
                )
            page_size = _parse_limit(q.get("pageSize"), 1000, None)
            page_req = LineagePageRequest(
                cursor=q.get("cursor"),
                pageSize=page_size,
                **filter_kwargs,
            )
            try:
                page = await deps.compose.storage.page_lineage(page_req)
                return _json(page)
            except LineageCursorError:
                return _error("BAD_REQUEST", "cursor is invalid", 400)
            except BaseException as e:
                request_id = request_id_of(request, deps)
                await report_host_error(deps, "lineage", request_id, e)
                return _error(
                    "INTERNAL",
                    "lineage paging failed; see the observability hook (on_error) for details",
                    500,
                    request_id,
                )

        events = await deps.compose.storage.list_lineage(LineageFilter(limit=limit, **filter_kwargs))
        return _json({"events": events})

    # --- Usage analytics -----------------------------------------------
    @router.get("/analytics/summary")
    async def analytics_summary(request: Request) -> Response:
        denied = await require_governance(deps, request, GovernanceOperation(kind="analytics.read"))
        if denied is not None:
            return denied
        if deps.analytics_summarizer is None:
            return _error("NOT_IMPLEMENTED", "analytics summarizer is not configured", 501)
        q = request.query_params
        since_raw = q.get("since")
        since = parse_iso8601(since_raw) if since_raw is not None else None
        if since_raw is not None and since is None:
            return _error("BAD_REQUEST", "since must be an ISO8601 timestamp", 400)
        until_raw = q.get("until")
        until = parse_iso8601(until_raw) if until_raw is not None else None
        if until_raw is not None and until is None:
            return _error("BAD_REQUEST", "until must be an ISO8601 timestamp", 400)
        limit = _parse_limit(q.get("limit"), ANALYTICS_MAX_LIMIT, ANALYTICS_DEFAULT_LIMIT)
        assert limit is not None  # a default is given, so it is never None
        tenant = await _resolve_tenant(deps, request)
        events: list[LineageEventRecord] = await deps.compose.storage.list_lineage(
            LineageFilter(since=since, until=until, limit=limit, tenant=tenant)
        )
        truncated = len(events) >= limit
        window: dict[str, Any] = {"limit": limit, "truncated": truncated}
        if since is not None:
            window["since"] = since
        if until is not None:
            window["until"] = until
        if tenant is not None:
            window["tenant"] = tenant
        summary = deps.analytics_summarizer(
            list(events), AnalyticsWindow(tenant=tenant, since=since, until=until)
        )
        return _json({"window": window, "summary": summary})

    # --- Telemetry ------------------------------------------------------------
    @router.post("/telemetry")
    async def telemetry_route(request: Request) -> Response:
        denied = await require_governance(deps, request, GovernanceOperation(kind="telemetry.write"))
        if denied is not None:
            return denied
        request_id = request_id_of(request, deps)
        events = parse_telemetry_body(await _read_json(request))
        if events is None:
            return _error("BAD_REQUEST", "events array required (max 500)", 400)
        tenant = await _resolve_tenant(deps, request)
        for event in events:
            try:
                if deps.recorder is None:
                    continue
                if isinstance(event, RenderedEvent):
                    await deps.recorder.rendered(
                        spec_hash=event.specHash,
                        surface=event.surface or "web",
                        renderer=event.renderer or "unknown",
                        duration_ms=event.durationMs,
                        tenant=tenant,
                    )
                else:
                    await deps.recorder.component_used(
                        artifact_id=event.artifactId,
                        surface=event.surface or "web",
                        outcome=event.outcome or "ok",
                        session_id=event.sessionId,
                        tenant=tenant,
                    )
            except BaseException as e:
                await report_host_error(deps, "telemetry", request_id, e)
        return _json({"ok": True})

    # --- Approval issuance for "approve"-tier governed Actions (design.md #63, SPEC ACT-APR-001 [Draft]) --
    @router.post("/approvals")
    async def approvals_route(request: Request) -> Response:
        denied = await require_governance(deps, request, GovernanceOperation(kind="action.approve"))
        if denied is not None:
            return denied
        if deps.approvals is None:
            return _error("NOT_IMPLEMENTED", "approvals are not configured for this host", 501)
        request_id = request_id_of(request, deps)
        body = parse_approval_request_body(await _read_json(request))
        if body is None:
            return _error("BAD_REQUEST", "action, payloadHash, and requesterId are required", 400)
        approver = await _get_principal(deps, request)
        # design.md #63: an approver must not be able to approve their own pending action. The
        # ApprovalPort itself also refuses this (defense in depth), but checking here first gives a
        # clearer, dedicated message rather than surfacing whatever generic error the port happens to raise.
        if approver.id == body.requester_id:
            return _error("BAD_REQUEST", "an approver cannot approve their own request", 400)
        tenant = await _resolve_tenant(deps, request)
        try:
            token = await deps.approvals.issue_approval(
                action=body.action,
                payload_hash=body.payload_hash,
                requester_id=body.requester_id,
                approver_id=approver.id,
                tenant=tenant,
                ttl_seconds=body.ttl_seconds,
            )
            return _json({"approval": token})
        except BaseException as e:
            await report_host_error(deps, "approvals", request_id, e)
            if getattr(e, "code", None) == APPROVAL_ISSUE_ERROR_CODE:
                return _error("BAD_REQUEST", _message(e), 400, request_id)
            return _error("INTERNAL", _APPROVAL_INTERNAL_ERROR_MESSAGE, 500, request_id)

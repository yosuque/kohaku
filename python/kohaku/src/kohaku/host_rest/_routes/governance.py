"""Governance/audit route group: /lineage, /analytics/summary, /telemetry.

Split out of the former monolithic `_fastapi_routes.py` to mirror packages/host-rest/src/routes/governance.ts.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from starlette.requests import Request
from starlette.responses import Response

from kohaku.spec import LineageEventRecord, LineageFilter

from ..bodies import RenderedEvent, parse_telemetry_body
from ..deps import AnalyticsWindow, KohakuHostDeps
from ..governance_policy import GovernanceOperation
from .shared import (
    _error,
    _json,
    _parse_limit,
    _read_json,
    _resolve_tenant,
    parse_iso8601,
    report_host_error,
    request_id_of,
    require_governance,
)

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
        events = await deps.compose.storage.list_lineage(
            LineageFilter(
                type=types if types else None,
                intentHash=q.get("intentHash"),
                artifactId=q.get("artifactId"),
                specHash=q.get("specHash"),
                since=since,
                until=until,
                limit=limit,
                tenant=tenant,
            )
        )
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

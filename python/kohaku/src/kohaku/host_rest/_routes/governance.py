"""Governance/audit route group: /lineage, /analytics/summary, /telemetry.

Split out of the former monolithic `_fastapi_routes.py` to mirror packages/host-rest/src/routes/governance.ts.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, cast

from fastapi import APIRouter
from starlette.requests import Request
from starlette.responses import Response

from kohaku.host_core import ApprovalIssuedRecorder, fail_open
from kohaku.spec import (
    APPROVAL_ISSUE_ERROR_CODE,
    DEFAULT_APPROVAL_TTL_SECONDS,
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
_APPROVAL_INTERNAL_ERROR_MESSAGE = (
    "approval issuance failed; see the observability hook (on_error) for details"
)

# The 501 message for POST /approvals on a host that has not wired authorize_governance.
_APPROVAL_AUTHORIZATION_REQUIRED_MESSAGE = (
    "approval issuance requires an approver authorization: wire deps.authorize_governance to authorize "
    "the action.approve operation"
)

# Aggregation window for usage analytics. Default 200 / max 1000 (aligned with the /lineage window constraint).
ANALYTICS_DEFAULT_LIMIT = 200
ANALYTICS_MAX_LIMIT = 1000


def _now() -> datetime:
    """The wall clock `POST /approvals` stamps `expires_at` from (a module-level seam so tests can pin it)."""
    return datetime.now(UTC)


def _iso_utc(moment: datetime) -> str:
    """Equivalent to `Date#toISOString()`: UTC, three-digit milliseconds, trailing Z."""
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


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

        events = await deps.compose.storage.list_lineage(
            LineageFilter(limit=limit, **filter_kwargs)
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
        denied = await require_governance(
            deps, request, GovernanceOperation(kind="telemetry.write")
        )
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
        if deps.approvals is None:
            return _error("NOT_IMPLEMENTED", "approvals are not configured for this host", 501)
        # SPEC ACT-APR-001 (e): issuing is a privileged act, so unlike the other governance routes it does
        # not fall back to "allowed when unwired" -- without the hook any authenticated principal other than
        # the requester could mint an approval.
        if deps.authorize_governance is None:
            return _error("NOT_IMPLEMENTED", _APPROVAL_AUTHORIZATION_REQUIRED_MESSAGE, 501)
        request_id = request_id_of(request, deps)
        body = parse_approval_request_body(await _read_json(request))
        if body is None:
            return _error("BAD_REQUEST", "action, payloadHash, and requesterId are required", 400)
        # The body is parsed before authorizing so the hook can scope the grant to the action being approved
        # (`operation.action`): a role that may approve one action is not thereby an approver of every action.
        denied = await require_governance(
            deps, request, GovernanceOperation(kind="action.approve", action=body.action)
        )
        if denied is not None:
            return denied
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
        except Exception as e:
            await report_host_error(deps, "approvals", request_id, e)
            if getattr(e, "code", None) == APPROVAL_ISSUE_ERROR_CODE:
                return _error("BAD_REQUEST", _message(e), 400, request_id)
            return _error("INTERNAL", _APPROVAL_INTERNAL_ERROR_MESSAGE, 500, request_id)
        # Audit the issuance (design.md #72), only now that it succeeded and fail-open like every other
        # action.* record: a recording failure must never turn a minted token into an error response. The
        # event carries the approver as its actor and never the token itself. The ApprovalPort does not report
        # its own expiry, so `expires_at` is issue time + the REQUESTED TTL (or DEFAULT_APPROVAL_TTL_SECONDS),
        # not the lifetime the port granted. That is advisory: it differs from the real expiry when the port's
        # own default TTL differs from that constant, or when the port clamps the TTL (the HMAC port clamps to
        # `max_ttl_seconds`, 3600 s by default, so a 24 h request records a 24 h `expires_at` for a token that
        # dies after 1 h). A reader (the admin console) must therefore treat it as information only, never as
        # proof a token is still valid or a reason to refuse minting a new one. Future fix: ApprovalPort.issue_approval returns the expiry.
        # A recorder without the optional `approval_issued` hook is skipped.
        recorder = (
            cast(ApprovalIssuedRecorder, deps.action_audit_recorder)
            if hasattr(deps.action_audit_recorder, "approval_issued")
            else None
        )
        if recorder is not None:
            ttl_seconds = (
                body.ttl_seconds if body.ttl_seconds is not None else DEFAULT_APPROVAL_TTL_SECONDS
            )
            expires_at = _iso_utc(_now() + timedelta(seconds=ttl_seconds))

            async def _record_issued() -> None:
                await recorder.approval_issued(
                    action=body.action,
                    payload_hash=body.payload_hash,
                    requester_id=body.requester_id,
                    approver_id=approver.id,
                    ttl_seconds=ttl_seconds,
                    expires_at=expires_at,
                    principal=approver,
                    tenant=tenant,
                )

            await fail_open(
                _record_issued, lambda e: report_host_error(deps, "approvals.audit", request_id, e)
            )
        return _json({"approval": token})

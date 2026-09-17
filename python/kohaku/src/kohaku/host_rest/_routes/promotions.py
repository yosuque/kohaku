"""Promotion pipeline route group: /promotions* (list / evaluate / get / preview / approve / reject / withdraw / actions).

Split out of the former monolithic `_fastapi_routes.py` to mirror packages/host-rest/src/routes/promotions.ts.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from starlette.requests import Request
from starlette.responses import Response

from kohaku.lineage import (
    JudgeResult,
    PromotionAction,
    Publish,
    ReviewApprove,
    ReviewReject,
    SchemaPropose,
    Unpublish,
    Withdraw,
)
from kohaku.spec import GovernanceErrorDiscriminators, Scope

from ..bodies import parse_component_draft, parse_promotion_action
from ..deps import KohakuHostDeps
from ..governance_policy import GovernanceOperation
from .shared import (
    _DEFAULT_CAPABILITY_TTL,
    _error,
    _get_lock,
    _get_principal,
    _json,
    _message,
    _promotion_key,
    _read_json,
    _resolve_tenant,
    report_host_error,
    request_id_of,
    require_governance,
)


def _promotions_not_configured() -> Response:
    return _error("NOT_IMPLEMENTED", "promotions are not configured", 501)


def _extra_governance_kind_for(action: PromotionAction) -> str | None:
    """Additional governance kind the generic action route (POST /promotions/{artifact_id}/actions) requires
    on top of the route's blanket promotion.act check, keyed by the action's type (port of TS
    extraGovernanceKindFor in routes/promotions.ts). Without this, a role holding only promotion.act could
    reach judge.result (spoofing the judge verdict), review.approve/publish/schema.propose, or
    withdraw/unpublish through the generic route even though the dedicated named routes (/approve, /reject,
    /withdraw) gate the same transitions behind their own kinds. None means no additional kind is required
    beyond promotion.act (nominate / judge.start / review.start / review.requestChanges have no dedicated
    named route to mirror).
    """
    if isinstance(action, (ReviewApprove, Publish, SchemaPropose)):
        return "promotion.approve"
    if isinstance(action, ReviewReject):
        return "promotion.reject"
    if isinstance(action, (Withdraw, Unpublish)):
        return "promotion.withdraw"
    if isinstance(action, JudgeResult):
        return "promotion.judge"
    return None


_PROMOTION_INTERNAL_ERROR_MESSAGE = (
    "promotion transition failed; see the observability hook (on_error) for details"
)
"""The client-visible message for an unexpected promotion-transition failure (INTERNAL 500). An arbitrary
exception may carry internals unsafe to echo back; the original error still reaches the observability hook
(on_error) via report_host_error. The typed/expected failure branches above (PROMOTION_NOT_PUBLISHED /
PROMOTION_INVALID / NOT_FOUND) keep their own message — only this catch-all does not."""


async def _promotion_error(
    deps: KohakuHostDeps, request: Request, endpoint: str, e: BaseException
) -> Response:
    """Map a promotion-action exception into the error convention. Discriminated structurally since
    lineage is not depended on, using kohaku.spec's GovernanceErrorDiscriminators."""
    if getattr(e, "code", None) == GovernanceErrorDiscriminators.NOT_PUBLISHED_CODE:
        error: dict[str, Any] = {"code": "PROMOTION_NOT_PUBLISHED", "message": _message(e)}
        status_val = getattr(e, "status", None)
        if status_val is not None:
            error["status"] = status_val
        return _json({"error": error}, 409)
    name = getattr(e, "name", None) or type(e).__name__
    if name in (GovernanceErrorDiscriminators.TRANSITION_NAME, GovernanceErrorDiscriminators.NOT_REJECTED_NAME):
        return _error("PROMOTION_INVALID", _message(e), 422)
    # candidate/artifact lookup failure (ArtifactNotFoundError). Discriminated by code (not a message-text
    # match, which a wording change could break) — a safeguard for when get is unimplemented and
    # _ensure_artifact's pre-check could not run.
    if getattr(e, "code", None) == GovernanceErrorDiscriminators.ARTIFACT_NOT_FOUND_CODE:
        return _error("NOT_FOUND", _message(e), 404)
    # An unexpected failure. The raw message never reaches the client (it may leak internals); the original
    # error still reaches on_error via report_host_error.
    request_id = request_id_of(request, deps)
    await report_host_error(deps, endpoint, request_id, e)
    return _error("INTERNAL", _PROMOTION_INTERNAL_ERROR_MESSAGE, 500, request_id)


def register_promotion_routes(router: APIRouter, deps: KohakuHostDeps) -> None:
    """Registers the /promotions* routes onto router."""

    async def _ensure_artifact(artifact_id: str, tenant: str | None) -> Response | None:
        """Pre-read the artifact's existence via get; 404 if absent, None (may proceed) if found."""
        assert deps.promotions is not None
        candidate = await deps.promotions.get(artifact_id, tenant=tenant)
        if candidate is None:
            return _error("NOT_FOUND", f"unknown artifact {artifact_id}", 404)
        return None

    @router.get("/promotions")
    async def promotions_list(request: Request) -> Response:
        if deps.promotions is None:
            return _promotions_not_configured()
        denied = await require_governance(deps, request, GovernanceOperation(kind="promotion.list"))
        if denied is not None:
            return denied
        tenant = await _resolve_tenant(deps, request)
        status = request.query_params.get("status")
        if status is not None and status != "":
            candidates = await deps.promotions.list_by_status(status, tenant=tenant)
        else:
            candidates = await deps.promotions.list_candidates(tenant=tenant)
        return _json({"candidates": candidates})

    @router.post("/promotions/reconcile")
    async def promotions_reconcile(request: Request) -> Response:
        """Operator escape hatch (#11): force the projection recovery from snapshot authority on demand, the
        same recovery reconcile() already runs at startup. Not scoped to one artifact or one tenant (it scans
        across every tenant), so unlike the other transition routes it does not resolve/check a per-artifact
        owning tenant — it is serialized under the promotion lock's tenant-neutral bucket
        (`_promotion_key(None)`), the same bucket approve/reject/withdraw/actions/evaluate use for an
        unscoped call. Only unscoped transitions share that bucket, though: a tenant-scoped approve/withdraw
        takes its own tenant's bucket and can still interleave with this scan. reconcile() itself re-reads each
        candidate's status right after its scan and skips a stale entry rather than acting on it (see
        reconcile()'s own docstring in kohaku.lineage.promotion.service), so a transition racing with this
        route cannot make reconcile apply a projection change against a candidate that has already moved on.
        Serializing this route against every per-tenant bucket (two-phase locking) would close the window at
        the scan level too, but is a structural follow-up, not implemented here.
        """
        if deps.promotions is None:
            return _promotions_not_configured()
        denied = await require_governance(deps, request, GovernanceOperation(kind="promotion.reconcile"))
        if denied is not None:
            return denied
        try:
            async with _get_lock(deps, _promotion_key(None)):
                summary = await deps.promotions.reconcile()
            return _json({"summary": summary})
        except BaseException as e:
            return await _promotion_error(deps, request, "promotion.reconcile", e)

    @router.post("/promotions/evaluate")
    async def promotions_evaluate(request: Request) -> Response:
        if deps.promotions is None:
            return _promotions_not_configured()
        denied = await require_governance(deps, request, GovernanceOperation(kind="promotion.evaluate"))
        if denied is not None:
            return denied
        tenant = await _resolve_tenant(deps, request)
        async with _get_lock(deps, _promotion_key(tenant)):
            candidates = await deps.promotions.evaluate_and_list(tenant=tenant)
        return _json({"candidates": candidates})

    @router.get("/promotions/{artifact_id}")
    async def promotions_get(request: Request, artifact_id: str) -> Response:
        if deps.promotions is None:
            return _promotions_not_configured()
        denied = await require_governance(
            deps, request, GovernanceOperation(kind="promotion.get", artifactId=artifact_id)
        )
        if denied is not None:
            return denied
        candidate = await deps.promotions.get(
            artifact_id, tenant=await _resolve_tenant(deps, request)
        )
        if candidate is None:
            return _error("NOT_FOUND", "unknown artifact", 404)
        return _json({"candidate": candidate})

    @router.post("/promotions/{artifact_id}/preview")
    async def promotions_preview(request: Request, artifact_id: str) -> Response:
        if deps.promotions is None:
            return _promotions_not_configured()
        denied = await require_governance(
            deps, request, GovernanceOperation(kind="promotion.preview", artifactId=artifact_id)
        )
        if denied is not None:
            return denied
        tenant = await _resolve_tenant(deps, request)
        candidate = await deps.promotions.get(artifact_id, tenant=tenant)
        if candidate is None:
            return _error("NOT_FOUND", "unknown artifact", 404)
        html = getattr(candidate, "html", None)
        sha256 = getattr(candidate, "sha256", None)
        ref = getattr(candidate, "ref", None)
        if html is None or sha256 is None:
            return _error(
                "NOT_FOUND", "no previewable artifact (html/sha256) is recorded", 404
            )
        capability: str | None = None
        if ref is not None:
            capability = await deps.authz.issue_capability(
                await _get_principal(deps, request),
                [Scope(kind="read", ref=ref)],
                ttl_seconds=deps.capability_ttl_seconds
                if deps.capability_ttl_seconds is not None
                else _DEFAULT_CAPABILITY_TTL,
            )
        preview: dict[str, Any] = {"html": html, "sha256": sha256}
        if ref is not None and capability is not None:
            preview["ref"] = ref
            preview["capability"] = capability
        return _json({"preview": preview})

    @router.post("/promotions/{artifact_id}/approve")
    async def promotions_approve(request: Request, artifact_id: str) -> Response:
        if deps.promotions is None:
            return _promotions_not_configured()
        denied = await require_governance(
            deps, request, GovernanceOperation(kind="promotion.approve", artifactId=artifact_id)
        )
        if denied is not None:
            return denied
        principal = await _get_principal(deps, request)
        tenant = await _resolve_tenant(deps, request)
        data = await _read_json(request)
        draft = parse_component_draft(data.get("draft")) if isinstance(data, dict) else None
        if draft is None:
            return _error(
                "BAD_REQUEST",
                "draft (componentType / version / intentName / description) is required",
                400,
            )
        not_found = await _ensure_artifact(artifact_id, tenant)
        if not_found is not None:
            return not_found
        try:
            async with _get_lock(deps, _promotion_key(tenant)):
                candidate = await deps.promotions.approve(
                    artifact_id, draft, principal, tenant=tenant
                )
            return _json({"candidate": candidate})
        except BaseException as e:
            return await _promotion_error(deps, request, "promotions.approve", e)

    @router.post("/promotions/{artifact_id}/reject")
    async def promotions_reject(request: Request, artifact_id: str) -> Response:
        if deps.promotions is None:
            return _promotions_not_configured()
        denied = await require_governance(
            deps, request, GovernanceOperation(kind="promotion.reject", artifactId=artifact_id)
        )
        if denied is not None:
            return denied
        principal = await _get_principal(deps, request)
        tenant = await _resolve_tenant(deps, request)
        not_found = await _ensure_artifact(artifact_id, tenant)
        if not_found is not None:
            return not_found
        try:
            async with _get_lock(deps, _promotion_key(tenant)):
                candidate = await deps.promotions.reject(artifact_id, principal, tenant=tenant)
            return _json({"candidate": candidate})
        except BaseException as e:
            return await _promotion_error(deps, request, "promotions.reject", e)

    @router.post("/promotions/{artifact_id}/withdraw")
    async def promotions_withdraw(request: Request, artifact_id: str) -> Response:
        if deps.promotions is None:
            return _promotions_not_configured()
        denied = await require_governance(
            deps, request, GovernanceOperation(kind="promotion.withdraw", artifactId=artifact_id)
        )
        if denied is not None:
            return denied
        principal = await _get_principal(deps, request)
        tenant = await _resolve_tenant(deps, request)
        data = await _read_json(request)
        reason = None
        if isinstance(data, dict) and data.get("reason") is not None:
            if not isinstance(data["reason"], str):
                return _error("BAD_REQUEST", "reason must be a string", 400)
            reason = data["reason"]
        not_found = await _ensure_artifact(artifact_id, tenant)
        if not_found is not None:
            return not_found
        try:
            async with _get_lock(deps, _promotion_key(tenant)):
                candidate = await deps.promotions.withdraw(
                    artifact_id, principal, reason, tenant=tenant
                )
            return _json({"candidate": candidate})
        except BaseException as e:
            return await _promotion_error(deps, request, "promotions.withdraw", e)

    @router.post("/promotions/{artifact_id}/actions")
    async def promotions_actions(request: Request, artifact_id: str) -> Response:
        if deps.promotions is None:
            return _promotions_not_configured()
        denied = await require_governance(
            deps, request, GovernanceOperation(kind="promotion.act", artifactId=artifact_id)
        )
        if denied is not None:
            return denied
        principal = await _get_principal(deps, request)
        tenant = await _resolve_tenant(deps, request)
        data = await _read_json(request)
        raw_action = data.get("action") if isinstance(data, dict) else None
        action = parse_promotion_action(raw_action, principal)
        if action is None:
            return _error("BAD_REQUEST", "action.kind is invalid", 400)
        # Kind-scoped authorization: beyond the blanket promotion.act check above, an action mirroring a
        # dedicated named route or recording a judge verdict requires its own additional governance kind.
        extra_kind = _extra_governance_kind_for(action)
        if extra_kind is not None:
            extra_denied = await require_governance(
                deps, request, GovernanceOperation(kind=extra_kind, artifactId=artifact_id)
            )
            if extra_denied is not None:
                return extra_denied
        not_found = await _ensure_artifact(artifact_id, tenant)
        if not_found is not None:
            return not_found
        try:
            async with _get_lock(deps, _promotion_key(tenant)):
                candidate = await deps.promotions.act(artifact_id, action, principal, tenant=tenant)
            return _json({"candidate": candidate})
        except BaseException as e:
            return await _promotion_error(deps, request, "promotions.actions", e)

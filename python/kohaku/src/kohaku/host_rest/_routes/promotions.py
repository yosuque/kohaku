"""Promotion pipeline route group: /promotions* (list / evaluate / get / preview / approve / reject / withdraw / actions).

Split out of the former monolithic `_fastapi_routes.py` to mirror packages/host-rest/src/routes/promotions.ts.
"""

from __future__ import annotations

from dataclasses import dataclass
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
from kohaku.spec import GovernanceErrorDiscriminators, Principal, Scope

from ..bodies import parse_component_draft, parse_promotion_action
from ..deps import KohakuHostDeps, PromotionsApi
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


@dataclass(frozen=True)
class _PromotionCtx:
    """The resolved context handed back by `_enter_promotion_route` once every guard in its preamble has
    passed. `promotions` is `deps.promotions` narrowed to non-None (the 501 guard already ruled out None),
    saving every call site its own `assert deps.promotions is not None`. `principal` / `tenant` are `None`
    when the call opted out of resolving them (`need_principal=False` / `need_tenant=False`) -- a route that
    never called `_get_principal` / `_resolve_tenant` on its own before this fold must not gain a new
    `deps.auth` / `deps.tenant` invocation just because folding made resolving them convenient."""

    deps: KohakuHostDeps
    promotions: PromotionsApi
    principal: Principal | None
    tenant: str | None


async def _enter_promotion_route(
    deps: KohakuHostDeps,
    request: Request,
    kind: str,
    *,
    governance_artifact_id: str | None = None,
    check_artifact_id: str | None = None,
    need_principal: bool = True,
    need_tenant: bool = True,
) -> _PromotionCtx | Response:
    """The guard preamble shared by all nine `/promotions*` routes, folded into one call. Order preserved
    exactly: promotions-not-configured (501) -> require_governance -> principal (if `need_principal`) ->
    tenant (if `need_tenant`) -> artifact existence 404 (only when `check_artifact_id` is given).

    A plain function, not a decorator: FastAPI introspects each route handler's own signature to build its
    request model, so wrapping the handler itself would be fragile here. The lock acquisition (`_get_lock` /
    `_promotion_key`) is intentionally left to each route -- it is not part of the shared preamble.

    Two independent knobs govern the artifact id, because a route can need one without the other:
    - `governance_artifact_id` is threaded into `GovernanceOperation.artifactId` for the blanket
      `require_governance` call. Every route that has an artifact id in its URL passes its real one here,
      matching today's `GovernanceOperation(kind=..., artifactId=artifact_id)` byte for byte -- this is a
      security-relevant input to a host-supplied `authorize_governance` hook and must never be substituted.
    - `check_artifact_id` triggers the generic trailing existence check (404 `f"unknown artifact {id}"`,
      mirroring the former nested `_ensure_artifact` helper), run only when given, immediately after tenant
      resolution. Only POST /promotions/{artifact_id}/reject passes this (its guard order matches exactly);
      the other five artifact-scoped routes leave it None and keep resolving/checking the artifact
      themselves, in their original position, because:
      - GET /promotions/{artifact_id} and POST /promotions/{artifact_id}/preview fetch the candidate
        themselves (they need the value, not just its existence) and report a *different* 404 message
        ("unknown artifact", no id) -- routing them through the generic check would change that response body.
      - POST .../approve, .../withdraw and .../actions read/validate the request body (and, for actions, run
        an extra kind-scoped governance check) *between* tenant resolution and the artifact-existence check;
        that validation must still fail with 400 before the artifact check ever runs, exactly as today.

    `need_principal` / `need_tenant` default to True (every route resolves both, matching most of the nine),
    but a caller that never resolved one of these before folding must pass False so `_get_principal` /
    `_resolve_tenant` -- both host-supplied callbacks (`deps.auth` / `deps.tenant`) -- are not invoked where
    they previously were not. This is independent of what `require_governance` itself does internally (it
    resolves both, unconditionally, whenever `deps.authorize_governance` is wired) -- that was already true
    before this fold and is unchanged by it. A route whose principal resolution is conditional on data only
    known after this call returns (POST .../preview, on whether the fetched candidate has a `ref`) passes
    `need_principal=False` and resolves it itself, at its original position and condition, via `_get_principal`
    directly -- not through this function's ctx.
    """
    if deps.promotions is None:
        return _promotions_not_configured()
    denied = await require_governance(
        deps, request, GovernanceOperation(kind=kind, artifactId=governance_artifact_id)
    )
    if denied is not None:
        return denied
    principal = await _get_principal(deps, request) if need_principal else None
    tenant = await _resolve_tenant(deps, request) if need_tenant else None
    if check_artifact_id is not None:
        candidate = await deps.promotions.get(check_artifact_id, tenant=tenant)
        if candidate is None:
            return _error("NOT_FOUND", f"unknown artifact {check_artifact_id}", 404)
    return _PromotionCtx(deps=deps, promotions=deps.promotions, principal=principal, tenant=tenant)


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
        """Pre-read the artifact's existence via get; 404 if absent, None (may proceed) if found. Kept
        separate from `_enter_promotion_route`'s own trailing check (same message/shape) for the three routes
        below (approve / withdraw / actions) whose body validation must run, and fail with 400, before this
        check -- see `_enter_promotion_route`'s docstring."""
        assert deps.promotions is not None
        candidate = await deps.promotions.get(artifact_id, tenant=tenant)
        if candidate is None:
            return _error("NOT_FOUND", f"unknown artifact {artifact_id}", 404)
        return None

    @router.get("/promotions")
    async def promotions_list(request: Request) -> Response:
        ctx = await _enter_promotion_route(deps, request, "promotion.list", need_principal=False)
        if isinstance(ctx, Response):
            return ctx
        status = request.query_params.get("status")
        if status is not None and status != "":
            candidates = await ctx.promotions.list_by_status(status, tenant=ctx.tenant)
        else:
            candidates = await ctx.promotions.list_candidates(tenant=ctx.tenant)
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
        ctx = await _enter_promotion_route(
            deps, request, "promotion.reconcile", need_principal=False, need_tenant=False
        )
        if isinstance(ctx, Response):
            return ctx
        try:
            async with _get_lock(deps, _promotion_key(None)):
                summary = await ctx.promotions.reconcile()
            return _json({"summary": summary})
        except BaseException as e:
            return await _promotion_error(deps, request, "promotion.reconcile", e)

    @router.post("/promotions/evaluate")
    async def promotions_evaluate(request: Request) -> Response:
        ctx = await _enter_promotion_route(deps, request, "promotion.evaluate", need_principal=False)
        if isinstance(ctx, Response):
            return ctx
        async with _get_lock(deps, _promotion_key(ctx.tenant)):
            candidates = await ctx.promotions.evaluate_and_list(tenant=ctx.tenant)
        return _json({"candidates": candidates})

    @router.get("/promotions/{artifact_id}")
    async def promotions_get(request: Request, artifact_id: str) -> Response:
        # check_artifact_id intentionally not passed: this route fetches the candidate itself (it needs the
        # value, not just a yes/no) and reports a distinct "unknown artifact" message (no id) on a miss --
        # see _enter_promotion_route's docstring. governance_artifact_id is still the real id: the blanket
        # governance call must see it, unchanged. need_principal=False: this route never resolved a principal.
        ctx = await _enter_promotion_route(
            deps, request, "promotion.get", governance_artifact_id=artifact_id, need_principal=False
        )
        if isinstance(ctx, Response):
            return ctx
        candidate = await ctx.promotions.get(artifact_id, tenant=ctx.tenant)
        if candidate is None:
            return _error("NOT_FOUND", "unknown artifact", 404)
        return _json({"candidate": candidate})

    @router.post("/promotions/{artifact_id}/preview")
    async def promotions_preview(request: Request, artifact_id: str) -> Response:
        # Same artifact-check reasoning as promotions_get above. need_principal=False: this route resolves a
        # principal only conditionally (below, when the candidate has a ref) -- that condition is data-
        # dependent and only known after this call returns, so it cannot be expressed as a ctx field here.
        ctx = await _enter_promotion_route(
            deps, request, "promotion.preview", governance_artifact_id=artifact_id, need_principal=False
        )
        if isinstance(ctx, Response):
            return ctx
        candidate = await ctx.promotions.get(artifact_id, tenant=ctx.tenant)
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
        # check_artifact_id intentionally not passed: the draft body must be read and validated (400 on a bad
        # draft) before the artifact-existence check runs, exactly as today -- see _enter_promotion_route's
        # docstring. _ensure_artifact below reproduces that check in its original position.
        # governance_artifact_id is still the real id, unchanged. need_principal / need_tenant default True:
        # this route always resolved both.
        ctx = await _enter_promotion_route(deps, request, "promotion.approve", governance_artifact_id=artifact_id)
        if isinstance(ctx, Response):
            return ctx
        assert ctx.principal is not None  # need_principal defaults True above
        data = await _read_json(request)
        draft = parse_component_draft(data.get("draft")) if isinstance(data, dict) else None
        if draft is None:
            return _error(
                "BAD_REQUEST",
                "draft (componentType / version / intentName / description) is required",
                400,
            )
        not_found = await _ensure_artifact(artifact_id, ctx.tenant)
        if not_found is not None:
            return not_found
        try:
            async with _get_lock(deps, _promotion_key(ctx.tenant)):
                candidate = await ctx.promotions.approve(
                    artifact_id, draft, ctx.principal, tenant=ctx.tenant
                )
            return _json({"candidate": candidate})
        except BaseException as e:
            return await _promotion_error(deps, request, "promotions.approve", e)

    @router.post("/promotions/{artifact_id}/reject")
    async def promotions_reject(request: Request, artifact_id: str) -> Response:
        # The one route whose guard order matches _enter_promotion_route's built-in artifact-existence check
        # exactly (immediately after tenant, same message) -- so it is the only one passing check_artifact_id.
        ctx = await _enter_promotion_route(
            deps,
            request,
            "promotion.reject",
            governance_artifact_id=artifact_id,
            check_artifact_id=artifact_id,
        )
        if isinstance(ctx, Response):
            return ctx
        assert ctx.principal is not None  # need_principal defaults True above
        try:
            async with _get_lock(deps, _promotion_key(ctx.tenant)):
                candidate = await ctx.promotions.reject(artifact_id, ctx.principal, tenant=ctx.tenant)
            return _json({"candidate": candidate})
        except BaseException as e:
            return await _promotion_error(deps, request, "promotions.reject", e)

    @router.post("/promotions/{artifact_id}/withdraw")
    async def promotions_withdraw(request: Request, artifact_id: str) -> Response:
        # Same reasoning as promotions_approve above: the optional reason body must be validated first.
        ctx = await _enter_promotion_route(deps, request, "promotion.withdraw", governance_artifact_id=artifact_id)
        if isinstance(ctx, Response):
            return ctx
        assert ctx.principal is not None  # need_principal defaults True above
        data = await _read_json(request)
        reason = None
        if isinstance(data, dict) and data.get("reason") is not None:
            if not isinstance(data["reason"], str):
                return _error("BAD_REQUEST", "reason must be a string", 400)
            reason = data["reason"]
        not_found = await _ensure_artifact(artifact_id, ctx.tenant)
        if not_found is not None:
            return not_found
        try:
            async with _get_lock(deps, _promotion_key(ctx.tenant)):
                candidate = await ctx.promotions.withdraw(
                    artifact_id, ctx.principal, reason, tenant=ctx.tenant
                )
            return _json({"candidate": candidate})
        except BaseException as e:
            return await _promotion_error(deps, request, "promotions.withdraw", e)

    @router.post("/promotions/{artifact_id}/actions")
    async def promotions_actions(request: Request, artifact_id: str) -> Response:
        # Same reasoning as promotions_approve above: the action body (and the extra kind-scoped governance
        # check it may trigger) must run before the artifact-existence check.
        ctx = await _enter_promotion_route(deps, request, "promotion.act", governance_artifact_id=artifact_id)
        if isinstance(ctx, Response):
            return ctx
        assert ctx.principal is not None  # need_principal defaults True above
        data = await _read_json(request)
        raw_action = data.get("action") if isinstance(data, dict) else None
        action = parse_promotion_action(raw_action, ctx.principal)
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
        not_found = await _ensure_artifact(artifact_id, ctx.tenant)
        if not_found is not None:
            return not_found
        try:
            async with _get_lock(deps, _promotion_key(ctx.tenant)):
                candidate = await ctx.promotions.act(artifact_id, action, ctx.principal, tenant=ctx.tenant)
            return _json({"candidate": candidate})
        except BaseException as e:
            return await _promotion_error(deps, request, "promotions.actions", e)

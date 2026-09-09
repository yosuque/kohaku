"""Fixation (L1->L0) management plane route group: /fixations, /fixations/proposals, /fixations/approve,
/fixations/{intent_hash}/remove.

Split out of the former monolithic `_fastapi_routes.py` to mirror packages/host-rest/src/routes/fixations.ts.
Reuses compose_with_fixation from the compose route group (fixations/approve materializes the candidate Spec
through the same fixation-aware compose path as /compose before pinning it).
"""

from __future__ import annotations

from fastapi import APIRouter
from starlette.requests import Request
from starlette.responses import Response

from kohaku.host_core import is_typed_host_error
from kohaku.spec import GovernanceErrorDiscriminators, finalize_intent

from ..bodies import SessionBody, parse_compose_body
from ..deps import KohakuHostDeps
from ..governance_policy import GovernanceOperation
from .compose import _COMPOSE_FAILED_MESSAGE, compose_with_fixation
from .shared import (
    _error,
    _fixation_key,
    _get_lock,
    _get_principal,
    _json,
    _message,
    _read_json,
    _resolve_tenant,
    report_host_error,
    request_id_of,
    require_governance,
    to_session,
)

# The client-visible message for an unexpected fixation-removal failure (INTERNAL 500). See
# _COMPOSE_FAILED_MESSAGE's doc (compose.py) for the rationale (an arbitrary exception's message may leak
# internals; the original error still reaches the observability hook via report_host_error).
_FIXATION_INTERNAL_ERROR_MESSAGE = "fixation removal failed; see the observability hook (on_error) for details"


def register_fixation_routes(router: APIRouter, deps: KohakuHostDeps) -> None:
    """Registers /fixations, /fixations/proposals, /fixations/approve, /fixations/{intent_hash}/remove onto router."""

    @router.get("/fixations")
    async def fixations_list(request: Request) -> Response:
        if deps.fixations is None:
            return _error("NOT_IMPLEMENTED", "fixations are not configured", 501)
        denied = await require_governance(deps, request, GovernanceOperation(kind="fixation.list"))
        if denied is not None:
            return denied
        tenant = await _resolve_tenant(deps, request)
        return _json({"fixations": await deps.fixations.list_fixations(tenant=tenant)})

    @router.get("/fixations/proposals")
    async def fixations_proposals(request: Request) -> Response:
        if deps.fixations is None:
            return _error("NOT_IMPLEMENTED", "fixations are not configured", 501)
        denied = await require_governance(deps, request, GovernanceOperation(kind="fixation.proposals"))
        if denied is not None:
            return denied
        tenant = await _resolve_tenant(deps, request)
        return _json({"proposals": await deps.fixations.proposals(tenant=tenant)})

    @router.post("/fixations/approve")
    async def fixations_approve(request: Request) -> Response:
        if deps.fixations is None:
            return _error("NOT_IMPLEMENTED", "fixations are not configured", 501)
        fixations = deps.fixations
        denied = await require_governance(deps, request, GovernanceOperation(kind="fixation.approve"))
        if denied is not None:
            return denied
        request_id = request_id_of(request, deps)
        principal = await _get_principal(deps, request)
        tenant = await _resolve_tenant(deps, request)
        body = parse_compose_body(await _read_json(request))
        if body is None or body.intent is None:
            return _error("BAD_REQUEST", "intent (canonical + params) is required", 400)
        try:
            intent = finalize_intent(body.intent)
            result = await compose_with_fixation(
                intent,
                to_session(SessionBody(), principal, tenant),
                deps,
                request_id=request_id,
            )
            # A generation failure must not be pinned as L0 for everyone: a deterministic fallback Spec
            # ("Could not render") is not fixatable.
            fb = result.spec.provenance.fallback
            if fb is not None:
                return _error(
                    "COMPOSE_FAILED",
                    f"composition fell back ({fb.reason}); a fallback Spec cannot be fixated",
                    422,
                    request_id,
                )
            # L2 free-form results are governed by the promotion pipeline (L2->L1), not fixation.
            if result.spec.provenance.tier == "L2":
                return _error(
                    "BAD_REQUEST",
                    "L2 free-form results are governed by the promotion pipeline (L2->L1), not fixation",
                    400,
                    request_id,
                )
            async with _get_lock(deps, _fixation_key(tenant, intent.hash)):
                record = await fixations.fixate(
                    pinned_spec=result.spec, approver=principal, tenant=tenant
                )
            return _json({"fixation": record})
        except BaseException as e:
            await report_host_error(deps, "fixations/approve", request_id, e)
            # An arbitrary exception's message never reaches the client (it may leak internals); a typed host
            # error (SpecError/ComposeError/etc.) still passes its own message through.
            client_message = _message(e) if is_typed_host_error(e) else _COMPOSE_FAILED_MESSAGE
            return _error("COMPOSE_FAILED", client_message, 500, request_id)

    @router.post("/fixations/{intent_hash}/remove")
    async def fixations_remove(request: Request, intent_hash: str) -> Response:
        if deps.fixations is None:
            return _error("NOT_IMPLEMENTED", "fixations are not configured", 501)
        fixations = deps.fixations
        denied = await require_governance(
            deps, request, GovernanceOperation(kind="fixation.remove", intentHash=intent_hash)
        )
        if denied is not None:
            return denied
        principal = await _get_principal(deps, request)
        tenant = await _resolve_tenant(deps, request)
        try:
            async with _get_lock(deps, _fixation_key(tenant, intent_hash)):
                await fixations.unfixate(intent_hash, principal, tenant=tenant)
        except BaseException as e:
            if getattr(e, "code", None) == GovernanceErrorDiscriminators.FIXATION_UNSUPPORTED_CODE:
                return _error("NOT_IMPLEMENTED", _message(e), 501)
            request_id = request_id_of(request, deps)
            await report_host_error(deps, "fixations/remove", request_id, e)
            client_message = _message(e) if is_typed_host_error(e) else _FIXATION_INTERNAL_ERROR_MESSAGE
            return _error("INTERNAL", client_message, 500, request_id)
        return _json({"ok": True})

"""Binding route group: /binding/resolve (reference-passing data resolution) and /binding/action (direct write path).

Split out of the former monolithic `_fastapi_routes.py` to mirror packages/host-rest/src/routes/binding.ts.
"""

from __future__ import annotations

from fastapi import APIRouter
from starlette.requests import Request
from starlette.responses import Response

from kohaku.host_core import ParsedInvokableRefOk, apply_action_effects, parse_invokable_ref
from kohaku.spec import InvocationContext, Principal, QueryRefError, VerifyRequest, VerifyResult

from ..bodies import parse_action_body
from ..deps import KohakuHostDeps
from .shared import (
    ANONYMOUS,
    _bearer_token,
    _error,
    _json,
    _message,
    _read_json,
    report_host_error,
    request_id_of,
)

# A raw downstream (DomainPort.invoke) failure never reaches the client verbatim on the REF_NOT_FOUND path: it
# may carry internals (SQL fragments, stack-trace text, library-internal wording). The original error still
# reaches the observability hook (on_error) via report_host_error.
_REF_NOT_FOUND_MESSAGE = "reference not found or not resolvable"


def _resolve_principal(deps: KohakuHostDeps, verdict: VerifyResult) -> Principal | Response:
    """Resolve the principal to act as for a verified capability. When deps.auth is wired (the host performs
    real authentication), a verify that returns ok=True without a principal is a capability-issuer
    misconfiguration and must not silently degrade to ANONYMOUS — doing so would let an authenticated
    deployment act as the demo user. Denied with 403 CAPABILITY_DENIED in that case. When deps.auth is unwired
    (the unauthenticated demo path), ANONYMOUS is the expected, intentional principal.
    Returns the Response to return as-is on denial, or the resolved Principal on success.
    """
    if verdict.principal is not None:
        return verdict.principal
    if deps.auth is None:
        return ANONYMOUS
    return _error("CAPABILITY_DENIED", "capability verified without a principal", 403)


def register_binding_routes(router: APIRouter, deps: KohakuHostDeps) -> None:
    """Registers /binding/resolve and /binding/action onto router."""

    # --- Reference-passing data resolution -----------------------------------
    @router.get("/binding/resolve")
    async def binding_resolve(request: Request) -> Response:
        ref_param = request.query_params.get("ref")
        if ref_param is None:
            return _error("BAD_REQUEST", "ref query parameter is required", 400)
        token = _bearer_token(request)
        if token is None:
            return _error(
                "CAPABILITY_REQUIRED", "Authorization: Bearer <capability> is required", 401
            )
        # Server-side paging/sorting: parse ref into base (with reserved params removed) and reserved via
        # host_core's parse_invokable_ref (shared with the MCP profile's resolve_binding tool / initial-data
        # preresolution). Capability verification is an exact match against base.raw (= the canonical form of
        # the $ref the Spec declared). Only known reserved-param keys (_cursor/_limit/_sort/_dir) are allowed —
        # since the reserved namespace is outside authorization checks, passing an unknown `_` key through would
        # let the data range be changed with parameters outside the capability.
        try:
            parsed = parse_invokable_ref(ref_param, deps.query_source)
        except (QueryRefError, ValueError) as e:
            return _error("BAD_REQUEST", _message(e), 400)
        if not isinstance(parsed, ParsedInvokableRefOk):
            return _error("SOURCE_MISMATCH", f'unknown query source "{parsed.source}"', 404)
        base, params = parsed.ref.base, parsed.ref.params
        verdict = await deps.authz.verify(token, VerifyRequest(kind="read", ref=base.raw))
        if not verdict.ok:
            return _error("CAPABILITY_DENIED", verdict.reason or "capability denied", 403)
        principal = _resolve_principal(deps, verdict)
        if isinstance(principal, Response):
            return principal
        try:
            data = await deps.domain.invoke(
                base.path,
                params,
                InvocationContext(principal=principal, capability=token),
            )
            return _json(data)
        except BaseException as e:
            # The raw error message never reaches the client (it may leak internals); the original error still
            # reaches on_error via report_host_error.
            request_id = request_id_of(request, deps)
            await report_host_error(deps, "binding/resolve", request_id, e)
            return _error("REF_NOT_FOUND", _REF_NOT_FOUND_MESSAGE, 404, request_id)

    # --- Direct write path ----------------------------------------------------
    @router.post("/binding/action")
    async def binding_action(request: Request) -> Response:
        body = parse_action_body(await _read_json(request))
        if body is None:
            return _error("BAD_REQUEST", "action is required", 400)
        token = _bearer_token(request)
        if token is None:
            return _error(
                "CAPABILITY_REQUIRED", "Authorization: Bearer <capability> is required", 401
            )
        verdict = await deps.authz.verify(token, VerifyRequest(kind="write", ref=body.action))
        if not verdict.ok:
            return _error("CAPABILITY_DENIED", verdict.reason or "capability denied", 403)
        principal = _resolve_principal(deps, verdict)
        if isinstance(principal, Response):
            return principal
        payload = body.payload if body.payload is not None else {}
        try:
            result = await deps.domain.invoke(
                body.action,
                payload,
                InvocationContext(principal=principal, capability=token),
            )
        except BaseException as e:
            # A failure of the write itself (domain.invoke) is not yet committed, so respond with an error.
            # The raw error message never reaches the client (see _REF_NOT_FOUND_MESSAGE).
            request_id = request_id_of(request, deps)
            await report_host_error(deps, "binding/action", request_id, e)
            return _error("REF_NOT_FOUND", _REF_NOT_FOUND_MESSAGE, 404, request_id)
        # Write-already-committed vs. side-effect-declaration failure: see host_core's apply_action_effects.
        # wide_catch=True preserves REST's pre-branch `except BaseException` at this call site.
        response = await apply_action_effects(
            deps.action_effects,
            body.action,
            payload,
            result,
            lambda e: report_host_error(deps, "binding/action", request_id_of(request, deps), e),
            wide_catch=True,
        )
        return _json(response)

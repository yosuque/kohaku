"""Binding route group: /binding/resolve (reference-passing data resolution) and /binding/action (direct write path).

Split out of the former monolithic `_fastapi_routes.py` to mirror packages/host-rest/src/routes/binding.ts.
"""

from __future__ import annotations

from fastapi import APIRouter
from starlette.requests import Request
from starlette.responses import Response

from kohaku.host_core import (
    ActionGateRequest,
    ActionGateResult,
    ParsedInvokableRefOk,
    apply_action_effects,
    parse_invokable_ref,
)
from kohaku.spec import (
    InvocationContext,
    JsonObject,
    Principal,
    QueryRefError,
    VerifyRequest,
    VerifyResult,
)

from ..bodies import parse_action_body
from ..deps import KohakuHostDeps
from .shared import (
    ANONYMOUS,
    _bearer_token,
    _error,
    _get_principal,
    _json,
    _message,
    _read_json,
    _resolve_tenant,
    action_gate_for,
    check_rate_limit,
    operation_index,
    report_host_error,
    request_id_of,
    safe_record,
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


async def _handle_action_gate_result(
    deps: KohakuHostDeps,
    gate_result: ActionGateResult,
    *,
    action: str,
    payload: JsonObject,
    principal: Principal,
    tenant: str | None,
    request_id: str,
) -> Response | None:
    """Maps one ActionGate.check outcome onto the REST response + audit trail (design.md #62/#63). Returns
    the Response to send back to the client (invalid / approvalRequired / denied), or None when the gate
    allowed the invoke and the caller should proceed to domain.invoke. Audit recording is always fail-open
    (kohaku.host_core.fail_open via safe_record): a recording failure must never turn an otherwise-successful
    allow, or an otherwise-correct denial, into a 500."""

    if gate_result.kind == "invalid":
        return _error(
            "ACTION_PARAMS_INVALID",
            "action parameters failed validation",
            422,
            request_id,
            issues=gate_result.issues,
        )

    if gate_result.kind == "approvalRequired":

        async def _record_approval_requested() -> None:
            if deps.action_audit_recorder is None:
                return
            await deps.action_audit_recorder.approval_requested(
                action=action,
                payload_hash=gate_result.payloadHash,
                tier=gate_result.tier,
                request_id=gate_result.requestId,
                payload=payload,
                principal=principal,
                tenant=tenant,
                correlation_id=request_id,
            )

        await safe_record(deps, "binding/action.audit", request_id, _record_approval_requested)
        message = (
            "this action requires confirmation (confirmed: true)"
            if gate_result.tier == "confirm"
            else "this action requires an approval token"
        )
        return _error(
            "APPROVAL_REQUIRED",
            message,
            403,
            request_id,
            approval={
                "requestId": gate_result.requestId,
                "action": action,
                "tier": gate_result.tier,
                "payloadHash": gate_result.payloadHash,
            },
        )

    if gate_result.kind == "denied":

        async def _record_denied() -> None:
            if deps.action_audit_recorder is None:
                return
            await deps.action_audit_recorder.denied(
                action=action,
                payload_hash=gate_result.payloadHash,
                tier=gate_result.tier,
                reason=gate_result.reason,
                principal=principal,
                tenant=tenant,
                correlation_id=request_id,
            )

        await safe_record(deps, "binding/action.audit", request_id, _record_denied)
        return _error(
            "APPROVAL_REQUIRED",
            gate_result.reason,
            403,
            request_id,
            approval={
                "requestId": gate_result.requestId,
                "action": action,
                "tier": gate_result.tier,
                "payloadHash": gate_result.payloadHash,
            },
        )

    # gate_result.kind == "allow"
    async def _record_allow() -> None:
        if deps.action_audit_recorder is None:
            return
        await deps.action_audit_recorder.invoked(
            action=action,
            payload_hash=gate_result.payloadHash,
            tier=gate_result.tier,
            principal=principal,
            tenant=tenant,
            correlation_id=request_id,
        )
        if gate_result.grant is not None:
            await deps.action_audit_recorder.approved(
                action=action,
                payload_hash=gate_result.payloadHash,
                grant=gate_result.grant,
                principal=principal,
                tenant=tenant,
                correlation_id=request_id,
            )

    await safe_record(deps, "binding/action.audit", request_id, _record_allow)
    return None


def register_binding_routes(router: APIRouter, deps: KohakuHostDeps) -> None:
    """Registers /binding/resolve and /binding/action onto router."""

    # --- Reference-passing data resolution -----------------------------------
    @router.get("/binding/resolve")
    async def binding_resolve(request: Request) -> Response:
        rate_limited = await check_rate_limit(
            deps, await _get_principal(deps, request), await _resolve_tenant(deps, request), "resolve"
        )
        if rate_limited is not None:
            return rate_limited
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
        rate_limited = await check_rate_limit(
            deps, await _get_principal(deps, request), await _resolve_tenant(deps, request), "action"
        )
        if rate_limited is not None:
            return rate_limited
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
        request_id = request_id_of(request, deps)
        tenant = await _resolve_tenant(deps, request)

        # Governed actions (design.md #62/#63): validate params and enforce the action's tier before
        # domain.invoke ever runs. An action absent from the DomainPort's own operation index (should not
        # normally happen once capability issuance has already scoped write access to it) is let through
        # ungated, matching the pre-existing (pre-F2) behavior for a host whose index and DomainPort
        # momentarily disagree.
        index = await operation_index(deps)
        entry = index.get(body.action)
        if entry is not None:
            gate = action_gate_for(deps)
            gate_result = await gate.check(
                ActionGateRequest(
                    descriptor=entry.descriptor,
                    params_schema=entry.params_schema,
                    payload=payload,
                    confirmed=body.confirmed,
                    approval=body.approval,
                    requester_id=principal.id,
                    tenant=tenant,
                )
            )
            gated = await _handle_action_gate_result(
                deps,
                gate_result,
                action=body.action,
                payload=payload,
                principal=principal,
                tenant=tenant,
                request_id=request_id,
            )
            if gated is not None:
                return gated

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

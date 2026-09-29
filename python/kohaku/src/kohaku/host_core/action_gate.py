"""kohaku.host_core.action_gate — the governed-action gate (port of packages/host-core/src/action-gate.ts).

design.md #62/#63: validates a payload against its action's params schema, then enforces the action's tier
("auto" / "confirm" / "approve").
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Literal

from kohaku.spec import (
    ActionParamIssue,
    ActionParamsSchema,
    ActionTier,
    ApprovalGrant,
    ApprovalPort,
    JsonObject,
    OperationDescriptor,
    action_payload_hash,
    find_unsafe_action_param_keys,
    validate_action_params,
)

NO_APPROVAL_PORT_REASON = "no ApprovalPort is configured for this host"
"""The ActionGateDenied.reason of a host with no ApprovalPort at all (fixed text, safe to show a client)."""


@dataclass(frozen=True)
class ActionGateAllow:
    """Allowed: params validated and the tier's gate (if any) is satisfied. Proceed to DomainPort.invoke."""

    tier: ActionTier
    payloadHash: str
    grant: ApprovalGrant | None = None
    """Present only when tier == "approve" (the grant that was successfully consumed)."""
    kind: Literal["allow"] = "allow"


@dataclass(frozen=True)
class ActionGateInvalid:
    """The payload carried a prototype-polluting key (an `unsafeKey` issue, SPEC ACT-PRM-001) or failed
    validate_action_params against the action's schema. Maps to 422 ACTION_PARAMS_INVALID."""

    issues: list[ActionParamIssue]
    kind: Literal["invalid"] = "invalid"


@dataclass(frozen=True)
class ActionGateApprovalRequired:
    """The tier's gate was not satisfied because nothing was presented yet: "confirm" without
    `confirmed: true`, or "approve" without an approval token at all. Maps to 403 APPROVAL_REQUIRED.
    request_id is freshly minted per check call (not persisted by the gate itself), for the caller to both
    surface on the error envelope and stamp onto the paired action.approvalRequested audit record."""

    tier: Literal["confirm", "approve"]
    payloadHash: str
    requestId: str
    kind: Literal["approvalRequired"] = "approvalRequired"


@dataclass(frozen=True)
class ActionGateDenied:
    """Tier "approve" and either (a) no ApprovalPort is configured for this host at all -- checked first,
    unconditionally, whether or not a token was presented, since no token could ever verify and no
    POST /approvals could ever mint one -- or (b) a token *was* presented but did not
    verify (wrong binding, expired, already used, self-approval). Distinguished from
    ActionGateApprovalRequired so the caller can record a distinct audit event (action.denied vs
    action.approvalRequested) even though both map to the same 403 APPROVAL_REQUIRED wire response."""

    payloadHash: str
    requestId: str
    reason: str
    tier: Literal["approve"] = "approve"
    kind: Literal["denied"] = "denied"


type ActionGateResult = ActionGateAllow | ActionGateInvalid | ActionGateApprovalRequired | ActionGateDenied


@dataclass(frozen=True)
class ActionGateRequest:
    """What `ActionGate.check` needs to decide one invoke attempt."""

    descriptor: OperationDescriptor
    """The operation descriptor for the action being invoked (its tier/confirmMessage govern the gate)."""
    payload: JsonObject
    params_schema: ActionParamsSchema | None = None
    """The descriptor's pre-validated params schema (OperationIndexEntry.params_schema), if any."""
    confirmed: bool | None = None
    """The request body's `confirmed` field (tier "confirm")."""
    approval: str | None = None
    """The request body's `approval` field (tier "approve")."""
    requester_id: str = ""
    """The invoking principal's id -- bound into the approval verification as the requester."""
    tenant: str | None = None


class ActionGate:
    """One gate is shared by every invoke of every action for a given host attach; it carries no per-action
    state itself (an ApprovalPort, if configured, owns whatever state single-use enforcement needs).

    Order of checks (payload key safety, then params, then tier) is deliberate: a payload that is invalid on its own terms should
    never demand a confirmation or an approval for it.
    """

    def __init__(self, approvals: ApprovalPort | None = None) -> None:
        self._approvals = approvals

    async def check(self, req: ActionGateRequest) -> ActionGateResult:
        # Whole-payload unsafe-key scan first, independent of any schema: an action with no params schema, an
        # undeclared property under additionalProperties, or a list with no `items` would otherwise let a
        # `__proto__` / `constructor` / `prototype` key through to DomainPort.invoke.
        unsafe_key_issues = find_unsafe_action_param_keys(req.payload)
        if unsafe_key_issues:
            return ActionGateInvalid(issues=unsafe_key_issues)
        if req.params_schema is not None:
            issues = validate_action_params(req.params_schema, req.payload)
            if issues:
                return ActionGateInvalid(issues=issues)

        payload_hash = action_payload_hash(req.payload)
        tier: ActionTier = req.descriptor.tier if req.descriptor.tier is not None else "auto"

        if tier == "auto":
            return ActionGateAllow(tier=tier, payloadHash=payload_hash)

        if tier == "confirm":
            if req.confirmed is True:
                return ActionGateAllow(tier=tier, payloadHash=payload_hash)
            return ActionGateApprovalRequired(
                tier=tier, payloadHash=payload_hash, requestId=str(uuid.uuid4())
            )

        # tier == "approve"
        if self._approvals is None:
            # Checked before whether a token was even presented: with no ApprovalPort at all, no token
            # this client could ever supply would verify, and POST /approvals can never mint one either --
            # so this fails closed unconditionally rather than teasing a retry via ActionGateApprovalRequired.
            return ActionGateDenied(
                payloadHash=payload_hash,
                requestId=str(uuid.uuid4()),
                reason=NO_APPROVAL_PORT_REASON,
            )
        if req.approval is None:
            return ActionGateApprovalRequired(
                tier=tier, payloadHash=payload_hash, requestId=str(uuid.uuid4())
            )
        verdict = await self._approvals.verify_approval(
            req.approval,
            action=req.descriptor.name,
            payload_hash=payload_hash,
            requester_id=req.requester_id,
            tenant=req.tenant,
        )
        if not verdict.ok:
            return ActionGateDenied(
                payloadHash=payload_hash,
                requestId=str(uuid.uuid4()),
                reason=verdict.reason if verdict.reason is not None else "approval denied",
            )
        return ActionGateAllow(tier=tier, payloadHash=payload_hash, grant=verdict.grant)


def create_action_gate(approvals: ApprovalPort | None = None) -> ActionGate:
    return ActionGate(approvals=approvals)


__all__ = [
    "ActionGate",
    "ActionGateAllow",
    "ActionGateApprovalRequired",
    "ActionGateDenied",
    "ActionGateInvalid",
    "ActionGateRequest",
    "ActionGateResult",
    "create_action_gate",
]

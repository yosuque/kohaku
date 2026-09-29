"""kohaku.host_core.action_gate_outcome — the shared audit trail + client-visible messages for one
ActionGate.check outcome (port of packages/host-core/src/action-gate-outcome.ts).

design.md #62/#63; SPEC LIN-ACT-001. Both host profiles (REST / MCP) call `record_action_gate_result` /
`record_undeclared_action_denial` so they record identical `action.*` events and use identical tier
messages for the same gate result, keeping only their own wire mapping of the returned outcome.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal

from kohaku.spec import (
    ActionParamIssue,
    ApprovalRequiredInfo,
    JsonObject,
    Principal,
    action_payload_hash,
)

from .action_audit import ActionAuditRecorder
from .action_gate import ActionGateResult
from .errors import fail_open

UNDECLARED_ACTION_MESSAGE = "action is not a declared DomainPort operation"
"""An action name absent from the DomainPort's own operation index is not a declared operation at all -- it
must never reach `domain.invoke` (fail-closed), on the same footing as a capability that lacks the needed
write scope (both hosts reuse that response shape rather than minting a new error code: REST's 403
CAPABILITY_DENIED, MCP's plain `capability denied: ...` tool error)."""

CONFIRMATION_REQUIRED_MESSAGE = "this action requires confirmation (confirmed: true)"
"""Client-visible message for a "confirm"-tier action invoked without `confirmed: true`."""

APPROVAL_TOKEN_REQUIRED_MESSAGE = "this action requires an approval token"
"""Client-visible message for an "approve"-tier action invoked without an approval token."""


@dataclass(frozen=True)
class ActionAuditContext:
    """The audit context both `record_action_gate_result` and `record_undeclared_action_denial` need."""

    recorder: ActionAuditRecorder | None
    """None = no audit recording (a host that wires no ActionAuditRecorder)."""
    action: str
    payload: JsonObject
    principal: Principal
    report: Callable[[BaseException], Awaitable[None]]
    """Reports a recording failure to the host's observability hook; must not raise."""
    correlation_id: str | None = None
    tenant: str | None = None
    """None for a profile that resolves no tenant (MCP)."""


@dataclass(frozen=True)
class ActionGateInvalidOutcome:
    """The payload failed params validation. Wire: 422 ACTION_PARAMS_INVALID carrying `issues`."""

    issues: list[ActionParamIssue]
    kind: Literal["invalid"] = "invalid"


@dataclass(frozen=True)
class ActionGateApprovalRequiredOutcome:
    """The tier gate was not satisfied. Wire: 403 APPROVAL_REQUIRED carrying `message` and `approval`. The
    gate's "approvalRequired" and "denied" results both surface as this one outcome (they differ only in the
    audit event recorded and in `message`)."""

    message: str
    approval: ApprovalRequiredInfo
    kind: Literal["approvalRequired"] = "approvalRequired"


@dataclass(frozen=True)
class ActionGateProceedOutcome:
    """The gate allowed the invoke: the caller proceeds to `DomainPort.invoke`."""

    kind: Literal["proceed"] = "proceed"


type ActionGateOutcome = ActionGateInvalidOutcome | ActionGateApprovalRequiredOutcome | ActionGateProceedOutcome


async def record_action_gate_result(
    gate_result: ActionGateResult, ctx: ActionAuditContext
) -> ActionGateOutcome:
    """The audit trail for one `ActionGate.check` outcome (design.md #62/#63; SPEC LIN-ACT-001): "invalid"
    records nothing, "approvalRequired" records `action.approvalRequested`, "denied" records `action.denied`,
    and "allow" records `action.invoked` (plus `action.approved` when a grant was consumed). Recording is
    always fail-open (`fail_open`): a recording failure must never turn an otherwise-successful allow, or an
    otherwise-correct denial, into an unhandled failure. Port of TS `recordActionGateResult`."""
    recorder = ctx.recorder

    if gate_result.kind == "invalid":
        return ActionGateInvalidOutcome(issues=gate_result.issues)

    if gate_result.kind == "approvalRequired":

        async def _record_approval_requested() -> None:
            if recorder is None:
                return
            await recorder.approval_requested(
                action=ctx.action,
                payload_hash=gate_result.payloadHash,
                tier=gate_result.tier,
                request_id=gate_result.requestId,
                payload=ctx.payload,
                principal=ctx.principal,
                tenant=ctx.tenant,
                correlation_id=ctx.correlation_id,
            )

        await fail_open(_record_approval_requested, ctx.report)
        return ActionGateApprovalRequiredOutcome(
            message=(
                CONFIRMATION_REQUIRED_MESSAGE
                if gate_result.tier == "confirm"
                else APPROVAL_TOKEN_REQUIRED_MESSAGE
            ),
            approval=ApprovalRequiredInfo(
                requestId=gate_result.requestId,
                action=ctx.action,
                tier=gate_result.tier,
                payloadHash=gate_result.payloadHash,
            ),
        )

    if gate_result.kind == "denied":

        async def _record_denied() -> None:
            if recorder is None:
                return
            await recorder.denied(
                action=ctx.action,
                payload_hash=gate_result.payloadHash,
                tier=gate_result.tier,
                reason=gate_result.reason,
                principal=ctx.principal,
                tenant=ctx.tenant,
                correlation_id=ctx.correlation_id,
            )

        await fail_open(_record_denied, ctx.report)
        return ActionGateApprovalRequiredOutcome(
            message=gate_result.reason,
            approval=ApprovalRequiredInfo(
                requestId=gate_result.requestId,
                action=ctx.action,
                tier=gate_result.tier,
                payloadHash=gate_result.payloadHash,
            ),
        )

    # gate_result.kind == "allow"
    async def _record_allow() -> None:
        if recorder is None:
            return
        await recorder.invoked(
            action=ctx.action,
            payload_hash=gate_result.payloadHash,
            tier=gate_result.tier,
            principal=ctx.principal,
            tenant=ctx.tenant,
            correlation_id=ctx.correlation_id,
        )
        if gate_result.grant is not None:
            await recorder.approved(
                action=ctx.action,
                payload_hash=gate_result.payloadHash,
                grant=gate_result.grant,
                principal=ctx.principal,
                tenant=ctx.tenant,
                correlation_id=ctx.correlation_id,
            )

    await fail_open(_record_allow, ctx.report)
    return ActionGateProceedOutcome()


async def record_undeclared_action_denial(ctx: ActionAuditContext) -> None:
    """Records `action.denied` (tier "auto": no governed-action tier applies to a name that was never a real
    operation) for an action name absent from the DomainPort's operation index -- the fail-closed rejection
    both hosts perform before the gate ever runs (SPEC ACT-PRM-001, MCPAPP-ACT-001; audit per LIN-ACT-001).
    Fail-open like `record_action_gate_result`. The host then answers with `UNDECLARED_ACTION_MESSAGE`. Port
    of TS `recordUndeclaredActionDenial`."""
    recorder = ctx.recorder

    async def _record() -> None:
        if recorder is None:
            return
        await recorder.denied(
            action=ctx.action,
            payload_hash=action_payload_hash(ctx.payload),
            tier="auto",
            reason=UNDECLARED_ACTION_MESSAGE,
            principal=ctx.principal,
            tenant=ctx.tenant,
            correlation_id=ctx.correlation_id,
        )

    await fail_open(_record, ctx.report)


__all__ = [
    "APPROVAL_TOKEN_REQUIRED_MESSAGE",
    "CONFIRMATION_REQUIRED_MESSAGE",
    "UNDECLARED_ACTION_MESSAGE",
    "ActionAuditContext",
    "ActionGateApprovalRequiredOutcome",
    "ActionGateInvalidOutcome",
    "ActionGateOutcome",
    "ActionGateProceedOutcome",
    "record_action_gate_result",
    "record_undeclared_action_denial",
]

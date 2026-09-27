"""kohaku.host_core.action_audit — audit-recording hooks for governed Actions (port of
packages/host-core/src/action-audit.ts).
"""

from __future__ import annotations

from typing import Literal, Protocol

from kohaku.spec import ActionTier, ApprovalGrant, JsonObject, Principal


class ActionAuditRecorder(Protocol):
    """Audit-recording hooks for governed Actions (design.md #62/#63); `kohaku.lineage`'s
    `create_action_audit_recorder` supplies the implementation, backed by its `action.*` event family --
    no recording happens if a host does not wire one). Mirrors the role of `ViewRecorder`
    (`action_effects.py`'s sibling): the Protocol lives here (host_core) so both host profiles can depend
    on the same contract, matching TS's `ActionAuditRecorder` (packages/host-core/src/action-audit.ts).

    Every method records unconditionally whatever it is given; a caller (a REST/MCP route) wraps each
    call in its own fail-open handling (`kohaku.host_core.errors.fail_open`) -- a recording failure must
    never take down an otherwise-successful (or otherwise-denied) action response.
    """

    async def invoked(
        self,
        *,
        action: str,
        payload_hash: str,
        tier: ActionTier,
        principal: Principal,
        tenant: str | None = None,
        correlation_id: str | None = None,
    ) -> None:
        """Records a successful invoke (the ActionGate returned "allow"). Never includes the payload itself."""
        ...

    async def denied(
        self,
        *,
        action: str,
        payload_hash: str,
        tier: ActionTier,
        reason: str,
        principal: Principal,
        tenant: str | None = None,
        correlation_id: str | None = None,
    ) -> None:
        """Records a denied invoke attempt: either the ActionGate returned "denied" (an "approve"-tier
        token was presented but did not verify, or no ApprovalPort is configured at all -- tier is
        "confirm" or "approve" for these), or the action name was rejected before the gate ever ran
        because it is not one of the DomainPort's own declared operations (tier is "auto" here -- no
        governed-action tier applies to a name that was never a real operation to begin with)."""
        ...

    async def approval_requested(
        self,
        *,
        action: str,
        payload_hash: str,
        tier: Literal["confirm", "approve"],
        request_id: str,
        payload: JsonObject,
        principal: Principal,
        tenant: str | None = None,
        correlation_id: str | None = None,
    ) -> None:
        """Records that an approval/confirmation is now pending (the ActionGate returned
        "approvalRequested": nothing was presented yet). `payload` is always passed here; whether it is
        actually persisted (versus only its hash) is the concrete recorder's own configuration
        (`create_action_audit_recorder`'s `record_payload` option), not a decision this call site makes."""
        ...

    async def approved(
        self,
        *,
        action: str,
        payload_hash: str,
        grant: ApprovalGrant,
        principal: Principal,
        tenant: str | None = None,
        correlation_id: str | None = None,
    ) -> None:
        """Records that an approval grant was successfully consumed (the ActionGate returned "allow" with
        a grant, i.e. tier "approve"). Recorded in addition to (not instead of) `invoked` for the same
        request."""
        ...


__all__ = ["ActionAuditRecorder"]

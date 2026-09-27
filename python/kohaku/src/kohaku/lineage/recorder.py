"""Adapter conforming to host-rest's ViewRecorder (Port of TS packages/lineage/src/recorder.ts).

Auto-records the REST surface's compose / events / telemetry into View Lineage.
computeSpecHash is a synchronous function of kohaku.spec (the existing port's style).
"""

from __future__ import annotations

from typing import Literal

from kohaku.spec import (
    ApprovalGrant,
    JsonObject,
    LineageActor,
    Principal,
    Surface,
    UISpec,
    compute_spec_hash,
)

from .lineage import ComposeTraceLike, Lineage


class ViewRecorder:
    """Equivalent to RestViewRecorder. Wraps Lineage and records the REST surface's events into View Lineage."""

    def __init__(self, lineage: Lineage) -> None:
        self._lineage = lineage

    async def composed(
        self,
        *,
        spec: UISpec,
        trace: ComposeTraceLike,
        surface: Surface,
        session_id: str | None = None,
        tenant: str | None = None,
        spec_hash: str | None = None,
        structure_hash: str | None = None,
    ) -> None:
        await self._lineage.view_composed(
            spec=spec,
            trace=trace,
            surface=surface,
            session_id=session_id,
            tenant=tenant,
            spec_hash=spec_hash,
            structure_hash=structure_hash,
        )

    async def interacted(
        self,
        *,
        intent_hash: str,
        component_id: str,
        on: str,
        payload: JsonObject,
        surface: Surface,
        session_id: str | None = None,
        tenant: str | None = None,
    ) -> None:
        await self._lineage.view_interacted(
            intent_hash=intent_hash,
            component_id=component_id,
            on=on,
            payload=payload,
            surface=surface,
            session_id=session_id,
            tenant=tenant,
        )

    async def rendered(
        self,
        *,
        spec_hash: str,
        surface: Surface,
        renderer: str,
        duration_ms: float | None = None,
        tenant: str | None = None,
    ) -> None:
        await self._lineage.view_rendered(
            spec_hash=spec_hash,
            surface=surface,
            renderer=renderer,
            duration_ms=duration_ms,
            tenant=tenant,
        )

    async def component_used(
        self,
        *,
        artifact_id: str,
        surface: Surface,
        outcome: str = "ok",
        session_id: str | None = None,
        tenant: str | None = None,
    ) -> None:
        # Observed real render via telemetry. Stamp source so it can be distinguished from compose-time recording (excluded from promotion aggregation).
        await self._lineage.component_used(
            artifact_id=artifact_id,
            surface=surface,
            outcome=outcome,
            session_id=session_id,
            source="telemetry",
            tenant=tenant,
        )

    async def fallback(
        self,
        *,
        spec: UISpec,
        reason: str,
        kind: str,
        surface: Surface,
        session_id: str | None = None,
        tenant: str | None = None,
        correlation_id: str | None = None,
    ) -> None:
        # Derive specHash / intentHash from spec and record view.fallback.
        # Makes the occurrence rate (L1/L2 failure, capability downgrade) observable from lineage.
        spec_hash = compute_spec_hash(spec)
        await self._lineage.view_fallback(
            spec_hash=spec_hash,
            reason=reason,
            surface=surface,
            kind=kind,
            intent_hash=spec.intent.hash,
            session_id=session_id,
            tenant=tenant,
            correlation_id=correlation_id,
        )


def create_view_recorder(lineage: Lineage) -> ViewRecorder:
    return ViewRecorder(lineage)


class ActionAuditRecorder:
    """Implements kohaku.host_core.action_audit.ActionAuditRecorder (structural typing -- Protocol, no
    inheritance needed), backed by `lineage`'s `action.*` event family. Every event is recorded with actor
    kohaku.spec.LineageActor(kind="user", id=principal.id) -- the principal that made the invoke request,
    whether or not that specific attempt was allowed, denied, or left pending (an approval decision
    itself, once made, is out of scope for this recorder: action.approved records *that* a given grant
    was consumed by this invoke, not the separate act of the approver having issued it).
    """

    def __init__(self, lineage: Lineage, *, record_payload: bool = False) -> None:
        self._lineage = lineage
        self._record_payload = record_payload

    async def invoked(
        self,
        *,
        action: str,
        payload_hash: str,
        tier: Literal["auto", "confirm", "approve"],
        principal: Principal,
        tenant: str | None = None,
        correlation_id: str | None = None,
    ) -> None:
        event: dict[str, object] = {"action": action, "payloadHash": payload_hash, "tier": tier}
        if correlation_id is not None:
            event["correlationId"] = correlation_id
        await self._lineage.action_invoked(event, LineageActor(kind="user", id=principal.id), tenant)  # type: ignore[arg-type]

    async def denied(
        self,
        *,
        action: str,
        payload_hash: str,
        tier: Literal["auto", "confirm", "approve"],
        reason: str,
        principal: Principal,
        tenant: str | None = None,
        correlation_id: str | None = None,
    ) -> None:
        event: dict[str, object] = {
            "action": action,
            "payloadHash": payload_hash,
            "tier": tier,
            "reason": reason,
        }
        if correlation_id is not None:
            event["correlationId"] = correlation_id
        await self._lineage.action_denied(event, LineageActor(kind="user", id=principal.id), tenant)  # type: ignore[arg-type]

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
        event: dict[str, object] = {
            "action": action,
            "payloadHash": payload_hash,
            "tier": tier,
            "requestId": request_id,
        }
        if self._record_payload:
            event["payload"] = payload
        if correlation_id is not None:
            event["correlationId"] = correlation_id
        await self._lineage.action_approval_requested(
            event,  # type: ignore[arg-type]
            LineageActor(kind="user", id=principal.id),
            tenant,
        )

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
        event: dict[str, object] = {
            "action": action,
            "payloadHash": payload_hash,
            "approverId": grant.approverId,
            "requesterId": grant.requesterId,
        }
        if correlation_id is not None:
            event["correlationId"] = correlation_id
        await self._lineage.action_approved(event, LineageActor(kind="user", id=principal.id), tenant)  # type: ignore[arg-type]


def create_action_audit_recorder(lineage: Lineage, *, record_payload: bool = False) -> ActionAuditRecorder:
    return ActionAuditRecorder(lineage, record_payload=record_payload)

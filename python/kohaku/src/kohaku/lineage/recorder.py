"""Adapter conforming to host-rest's ViewRecorder (Port of TS packages/lineage/src/recorder.ts).

Auto-records the REST surface's compose / events / telemetry into View Lineage.
computeSpecHash is a synchronous function of kohaku.spec (the existing port's style).
"""

from __future__ import annotations

from kohaku.spec import JsonObject, Surface, UISpec, compute_spec_hash

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
        )


def create_view_recorder(lineage: Lineage) -> ViewRecorder:
    return ViewRecorder(lineage)

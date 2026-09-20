"""kohaku.host_core.view_recorder — records view.fallback when a composed Spec carries a fallback (port of
packages/host-core/src/view-recorder.ts's `recordViewFallback`).

TS's `view-recorder.ts` additionally defines the shared `ViewRecorder` interface (`composed` / `interacted` /
`rendered?` / `componentUsed?` / `fallback?`). This port only moves `recordViewFallback` itself — both Python
hosts already carry their own structurally-equivalent `ViewRecorderProtocol` (kohaku.host_rest.deps,
kohaku.host_mcp.types), which host_core must not import (host_core may not depend on host_rest/host_mcp per
the layer contract), so `record_view_fallback` below is typed against a narrow, private, fallback-only
Protocol that both hosts' `ViewRecorderProtocol` already structurally satisfy.
"""

from __future__ import annotations

from typing import Protocol

from kohaku.spec import Surface, UISpec


class _FallbackRecorder(Protocol):
    """The narrow slice of ViewRecorder record_view_fallback needs — both host_rest's and host_mcp's own
    `ViewRecorderProtocol.fallback` structurally satisfy this as-is."""

    async def fallback(
        self,
        *,
        spec: UISpec,
        reason: str,
        kind: str,
        surface: Surface,
        session_id: str | None = ...,
        tenant: str | None = ...,
    ) -> None: ...


async def record_view_fallback(
    recorder: _FallbackRecorder | None,
    spec: UISpec,
    *,
    surface: Surface,
    session_id: str | None = None,
    tenant: str | None = None,
) -> None:
    """Records view.fallback when the spec includes a fallback (deterministic downgrade on L1/L2 generation
    failure / component downgrade via capability negotiation). The judgment source is `spec.provenance.fallback`,
    not the compose trace: negotiation downgrade happens every time at finish even after a cache hit, so
    without looking at `spec.provenance.fallback` the downgrade on the cache-hit path would be missed. A
    missing `kind` is treated as "generation" (compatible with older records that predate the field).

    Shared by both host profiles (REST's record_fallback_if_any and the MCP profile's `_audit_compose`) so the
    fallback-detection rule lives in exactly one place instead of two independently-drifting copies. No-op
    when `recorder` is None (matching both hosts' existing "recording is optional" contract).
    """
    fallback = spec.provenance.fallback
    if fallback is None:
        return
    if recorder is None:
        return
    await recorder.fallback(
        spec=spec,
        reason=fallback.reason,
        kind=fallback.kind if fallback.kind is not None else "generation",
        surface=surface,
        session_id=session_id,
        tenant=tenant,
    )

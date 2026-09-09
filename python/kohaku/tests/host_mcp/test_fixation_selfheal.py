"""TOCTOU guard test for the MCP fixation-short-circuit self-healing (architecture-1).

Threads a guard (ifFixatedAt, ifCatalogFingerprint) into invalidate at the stale check and verifies that if another
fixation was re-approved before invalidation (the current fixation's fingerprint does not match the stale-check
moment), it is not deleted. The same-shaped guard as the REST surface (_fastapi_routes.settle_fixation) is applied
on the MCP surface too.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from kohaku.host_mcp import McpHostDeps
from kohaku.host_mcp.server import _compose_with_fixation, _NlSource
from kohaku.lineage import create_fixations, create_lineage
from kohaku.spec import (
    FixationRecord,
    IntentInput,
    Principal,
    SessionContext,
    UISpec,
    finalize_intent,
)
from kohaku.storage import FileStoragePort

from ._helpers import SimpleAuthz, TrendDomain, make_compose_ctx

_APPROVER = Principal(id="admin")


def _intent_hash() -> str:
    # _helpers._Semantic normalizes NL input to canonical="sales.trend" / params={}.
    return finalize_intent(IntentInput(canonical="sales.trend", params={})).hash


def _spec(component_type: str) -> UISpec:
    return UISpec.model_validate(
        {
            "kohaku": "0.1",
            "intent": finalize_intent(
                IntentInput(canonical="sales.trend", params={})
            ).to_wire(),
            "dataVersion": "x",
            "components": [
                {"id": "root", "type": "layout.stack", "props": {}, "children": ["t"]},
                {"id": "t", "type": component_type, "props": {}},
            ],
            "events": [],
            "provenance": {"tier": "L0", "composedBy": "test", "cache": "miss"},
        }
    )


def _fixation(catalog_fingerprint: str, component_type: str) -> FixationRecord:
    return FixationRecord(
        intentHash=_intent_hash(),
        canonical="sales.trend",
        structureHash="sha256:" + "3" * 64,
        pinnedSpec=_spec(component_type),
        fixatedAt="2026-07-17T00:00:00Z",
        approver=_APPROVER,
        catalogFingerprint=catalog_fingerprint,
    )


class _SignalingFixations:
    """Wraps the real Fixations, capturing the guard passed to invalidate and signaling completion."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.invalidated = asyncio.Event()
        self.last_guard: Any = "UNSET"

    async def invalidate(
        self,
        intent_hash: str,
        reason: str,
        detail: str | None = None,
        tenant: str | None = None,
        guard: dict[str, Any] | None = None,
    ) -> None:
        self.last_guard = guard
        try:
            await self._inner.invalidate(intent_hash, reason, detail, tenant=tenant, guard=guard)
        finally:
            self.invalidated.set()

    async def refresh_fingerprint(
        self, intent_hash: str, catalog_fingerprint: str, tenant: str | None = None
    ) -> None:
        await self._inner.refresh_fingerprint(intent_hash, catalog_fingerprint, tenant=tenant)


def test_mcp_selfheal_passes_guard_and_skips_delete_on_mismatch(tmp_path: Path) -> None:
    async def run() -> None:
        ctx = make_compose_ctx(tmp_path)

        # The fixation service's storage holds a "re-approved" fixation with a different fingerprint.
        storage = FileStoragePort(tmp_path)
        await storage.put_fixation(_fixation("fp-current-reapproved", "text.heading"))
        fixations = _SignalingFixations(
            create_fixations(lineage=create_lineage(storage), storage=storage)
        )

        # lookup returns the old fixation that will be judged stale (unknown component type + different fingerprint).
        stale = _fixation("fp-old-stale", "no.such")

        async def _lookup(h: str, session: SessionContext) -> FixationRecord | None:
            return stale if h == _intent_hash() else None

        deps = McpHostDeps(
            compose=ctx,
            domain=TrendDomain(),
            authz=SimpleAuthz(),
            query_source="sales",
            fixation_lookup=_lookup,
            fixations=fixations,
        )

        # Since it is stale, the result from the normal compose fallback is returned.
        result = await _compose_with_fixation(_NlSource(text="Show me the sales trend"), deps)
        assert result.spec is not None

        # Wait until the self-healing invalidate runs.
        await asyncio.wait_for(fixations.invalidated.wait(), timeout=1.0)

        # The guard receives the fixatedAt and catalog fingerprint at the stale-check moment (the old fixation
        # obtained via lookup).
        assert fixations.last_guard == {
            "ifFixatedAt": "2026-07-17T00:00:00Z",
            "ifCatalogFingerprint": "fp-old-stale",
        }

        # Guard mismatch (the current fixation was re-approved with a different fingerprint), so it is not deleted.
        current = await storage.get_fixation(_intent_hash())
        assert current is not None
        assert current.catalogFingerprint == "fp-current-reapproved"
        # Since it was not deleted, no unfixated event is recorded either.
        assert await storage.list_lineage() == []

    asyncio.run(run())

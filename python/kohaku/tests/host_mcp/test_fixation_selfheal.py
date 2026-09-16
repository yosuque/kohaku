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


def test_mcp_fixation_admit_false_falls_back_to_normal_compose(tmp_path: Path) -> None:
    """fixation_admit gates delivery before the staleness check even runs (host_core's
    FixationDeliveryHost.admit): a fixation found via fixation_lookup that admit rejects behaves exactly like
    fixation_lookup having returned None — normal compose (the fixedSpecs fallback) delivers instead, and no
    self-heal call (refresh_fingerprint/invalidate) ever fires."""

    async def run() -> None:
        ctx = make_compose_ctx(tmp_path)

        # A fixation whose catalog fingerprint already matches the current one ("fresh" — would deliver as-is,
        # unchanged, with no self-heal call, if admitted) and whose pinnedSpec is structurally distinct from
        # the fixedSpecs fallback (trend_spec_builder: root + t + c) so delivery is unambiguous either way.
        admitted = _fixation(ctx.catalog.fingerprint, "text.heading")

        async def _lookup(h: str, session: SessionContext) -> FixationRecord | None:
            return admitted if h == _intent_hash() else None

        fixations = _SignalingFixations(
            create_fixations(lineage=create_lineage(FileStoragePort(tmp_path)), storage=FileStoragePort(tmp_path))
        )

        deps = McpHostDeps(
            compose=ctx,
            domain=TrendDomain(),
            authz=SimpleAuthz(),
            query_source="sales",
            fixation_lookup=_lookup,
            fixation_admit=lambda _fixation, _session: False,
            fixations=fixations,
        )

        result = await _compose_with_fixation(_NlSource(text="Show me the sales trend"), deps)

        # The fixedSpecs fallback (trend_spec_builder: heading + presentChart), not the single-heading
        # 2-component pinnedSpec above.
        types = [c.type for c in result.spec.components]
        assert types == ["layout.stack", "text.heading", "presentChart"]
        # admit ran before materialize_fixation, so no self-heal call was ever scheduled.
        await asyncio.sleep(0.05)
        assert not fixations.invalidated.is_set()
        assert fixations.last_guard == "UNSET"

    asyncio.run(run())


class _ConcurrencyTrackingFixations:
    """Records how many `invalidate` calls are in flight at once (for the keyed-mutex serialization test
    below) — `asyncio.sleep` inside the critical section widens the race window a real race would need."""

    def __init__(self) -> None:
        self.active = 0
        self.max_active = 0
        self.calls = 0
        self.done = asyncio.Event()

    async def invalidate(
        self,
        intent_hash: str,
        reason: str,
        detail: str | None = None,
        tenant: str | None = None,
        guard: dict[str, Any] | None = None,
    ) -> None:
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            await asyncio.sleep(0.05)
        finally:
            self.active -= 1
            self.calls += 1
            if self.calls >= 2:
                self.done.set()

    async def refresh_fingerprint(
        self, intent_hash: str, catalog_fingerprint: str, tenant: str | None = None
    ) -> None:
        return None


def test_mcp_selfheal_serializes_concurrent_calls_for_the_same_intent_hash(tmp_path: Path) -> None:
    """Two concurrent tool calls that both judge the same intentHash's fixation stale each fire a
    fire-and-forget self-heal invalidate — kohaku.host_core's shared keyed mutex (wired in
    host_mcp.server._fixation_host, keyed by intent_hash alone, symmetric with TS server.ts's
    fixationMutexByDeps) must serialize them so they never run concurrently (a get->put race that could
    otherwise interleave)."""

    async def run() -> None:
        ctx = make_compose_ctx(tmp_path)
        stale = _fixation("fp-old-stale", "no.such")

        async def _lookup(h: str, session: SessionContext) -> FixationRecord | None:
            return stale if h == _intent_hash() else None

        fixations = _ConcurrencyTrackingFixations()
        deps = McpHostDeps(
            compose=ctx,
            domain=TrendDomain(),
            authz=SimpleAuthz(),
            query_source="sales",
            fixation_lookup=_lookup,
            fixations=fixations,
        )

        results = await asyncio.gather(
            _compose_with_fixation(_NlSource(text="Show me the sales trend"), deps),
            _compose_with_fixation(_NlSource(text="Show me the sales trend"), deps),
        )
        assert all(r.spec is not None for r in results)

        await asyncio.wait_for(fixations.done.wait(), timeout=2.0)
        assert fixations.calls == 2
        # The critical assertion: the two self-heal invalidate calls never overlapped.
        assert fixations.max_active == 1

    asyncio.run(run())

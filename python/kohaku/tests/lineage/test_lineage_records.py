"""Tests for View / Component Lineage recording (the recording / fallback / tenant parts of lineage.test.ts).

Uses a tmp_path FileStoragePort instead of TS's in-memory double (a repository convention).
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from kohaku.lineage import (
    artifact_id_of,
    create_lineage,
    create_promotions,
    create_view_recorder,
)
from kohaku.spec import LineageActor, LineageEventRecord, LineageFilter, compute_spec_hash
from kohaku.storage import FileStoragePort

from ._helpers import (
    L2_HTML,
    CountingStorage,
    FakeTrace,
    l1_spec,
    l2_spec,
    negotiated_spec,
)

TRACE = FakeTrace(durationMs=10.0)


def _types(records: list[LineageEventRecord]) -> list[str]:
    return [e.type for e in records]


def test_l2_view_composed_records_generated_and_used(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage)
        spec = l2_spec()
        artifact_id = artifact_id_of(spec.components[1].artifact.sha256)  # type: ignore[union-attr]

        await lineage.view_composed(spec=spec, trace=TRACE, surface="chat", session_id="s1")
        events = await storage.list_lineage()
        assert _types(events) == ["view.composed", "component.generated", "component.used"]

        generated = events[1]
        assert generated.payload["artifactId"] == artifact_id
        assert generated.payload["request"] == "as a heatmap"
        # The preview re-mount material (the artifact body + the data reference at generation time) is kept too
        assert generated.payload["html"] == L2_HTML
        assert generated.payload["ref"] == "query://sales/trend?metric=revenue"
        assert generated.actor.kind == "model"

        # On the 2nd time (cache hit), generated is not duplicated and only used increases
        await lineage.view_composed(spec=l2_spec(cache="hit"), trace=TRACE, surface="web")
        types = _types(await storage.list_lineage())
        assert types.count("component.generated") == 1
        assert types.count("component.used") == 2

        history = await lineage.history(artifact_id)
        assert _types(history) == ["component.generated", "component.used", "component.used"]

    asyncio.run(run())


def test_l0_l1_view_composed_only_composed(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage)
        await lineage.view_composed(spec=l1_spec(), trace=TRACE, surface="web")
        events = await storage.list_lineage()
        assert _types(events) == ["view.composed"]
        assert events[0].payload["tier"] == "L1"

    asyncio.run(run())


def test_explain_view_follows_spec_hash(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage)
        spec = l2_spec()
        await lineage.view_composed(spec=spec, trace=TRACE, surface="chat")
        explain = await lineage.explain_view(compute_spec_hash(spec))
        assert len(explain) >= 2  # composed + generated

    asyncio.run(run())


def test_precomputed_hashes_are_used_without_recompute(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage)
        spec = l2_spec()
        fake_spec_hash = "sha256:" + "f" * 64
        fake_structure_hash = "sha256:" + "e" * 64
        assert fake_spec_hash != compute_spec_hash(spec)

        await lineage.view_composed(
            spec=spec,
            trace=TRACE,
            surface="web",
            spec_hash=fake_spec_hash,
            structure_hash=fake_structure_hash,
        )
        events = await storage.list_lineage()
        composed = next(e for e in events if e.type == "view.composed")
        assert composed.payload["specHash"] == fake_spec_hash
        assert composed.payload["structureHash"] == fake_structure_hash
        # component.generated (L2) inherits the same specHash too (sharing the single computation).
        generated = next(e for e in events if e.type == "component.generated")
        assert generated.payload["specHash"] == fake_spec_hash

    asyncio.run(run())


def test_hashes_computed_internally_when_absent(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage)
        spec = l2_spec()
        await lineage.view_composed(spec=spec, trace=TRACE, surface="web")
        composed = next(e for e in await storage.list_lineage() if e.type == "view.composed")
        assert composed.payload["specHash"] == compute_spec_hash(spec)

    asyncio.run(run())


def test_generated_dedup_avoids_second_storage_lookup(tmp_path: Path) -> None:
    async def run() -> None:
        storage = CountingStorage(tmp_path)
        lineage = create_lineage(storage)
        # 1st time (miss): query storage and record generated.
        await lineage.view_composed(spec=l2_spec(), trace=TRACE, surface="web")
        assert storage.generated_lookups == 1
        # 2nd time (miss, same artifactId): a Set hit means listLineage is not called.
        await lineage.view_composed(spec=l2_spec(), trace=TRACE, surface="web")
        assert storage.generated_lookups == 1
        # Correctness is unchanged: generated once, used twice.
        events = await storage.list_lineage()
        assert _types(events).count("component.generated") == 1
        assert _types(events).count("component.used") == 2

    asyncio.run(run())


def test_fallback_records_negotiation_with_hashes(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        recorder = create_view_recorder(create_lineage(storage))
        spec = negotiated_spec()
        assert spec.provenance.fallback is not None

        await recorder.fallback(
            spec=spec,
            reason=spec.provenance.fallback.reason,
            kind="negotiation",
            surface="web",
            session_id="s1",
        )
        fallbacks = [e for e in await storage.list_lineage() if e.type == "view.fallback"]
        assert len(fallbacks) == 1
        payload = fallbacks[0].payload
        assert payload["kind"] == "negotiation"
        assert payload["intentHash"] == spec.intent.hash
        assert payload["specHash"] == compute_spec_hash(spec)
        assert payload["surface"] == "web"
        assert payload["sessionId"] == "s1"
        assert payload["reason"] == "capability negotiation"

    asyncio.run(run())


def test_fallback_omits_session_id_when_absent(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        recorder = create_view_recorder(create_lineage(storage))
        spec = negotiated_spec()
        assert spec.provenance.fallback is not None

        await recorder.fallback(
            spec=spec, reason=spec.provenance.fallback.reason, kind="generation", surface="chat"
        )
        payload = next(
            e for e in await storage.list_lineage() if e.type == "view.fallback"
        ).payload
        assert payload["kind"] == "generation"
        assert "sessionId" not in payload

    asyncio.run(run())


def test_record_stamps_tenant_only_when_present(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage)
        with_tenant = await lineage.record(
            "intent.observed", {"intentHash": "h"}, LineageActor(kind="system"), "acme"
        )
        without_tenant = await lineage.record("intent.observed", {"intentHash": "h"})
        assert with_tenant.tenant == "acme"
        # The dataclass always has a tenant field, but when unspecified it is None (omitted in the wire form).
        assert without_tenant.tenant is None

    asyncio.run(run())


def test_view_composed_propagates_tenant(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage)
        await lineage.view_composed(
            spec=l2_spec(), trace=TRACE, surface="chat", session_id="s1", tenant="acme"
        )
        events = await storage.list_lineage()
        assert _types(events) == ["view.composed", "component.generated", "component.used"]
        assert all(e.tenant == "acme" for e in events)
        # Do not mix tenant into the payload (only the record's tenant field).
        assert "tenant" not in events[0].payload

    asyncio.run(run())


def test_generated_recorded_per_tenant_even_on_cache_hit(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage)
        spec = l2_spec()  # cache == "miss"
        artifact_id = artifact_id_of(spec.components[1].artifact.sha256)  # type: ignore[union-attr]

        # tenant acme: generated on miss -> component.generated is recorded for acme.
        await lineage.view_composed(
            spec=spec, trace=TRACE, surface="web", session_id="s1", tenant="acme"
        )
        # tenant globex: receives the same Spec as cache:hit (the Spec cache is tenant-neutral).
        await lineage.view_composed(
            spec=l2_spec(cache="hit"), trace=TRACE, surface="web", session_id="s2", tenant="globex"
        )

        generated = [e for e in await storage.list_lineage() if e.type == "component.generated"]
        assert sorted(e.tenant for e in generated if e.tenant is not None) == ["acme", "globex"]

        promotions = create_promotions(
            lineage=lineage,
            storage=storage,
            policy=None,
        )
        assert await promotions.get(artifact_id, "acme") is not None
        assert await promotions.get(artifact_id, "globex") is not None
        globex_candidates = await promotions.list_candidates(tenant="globex")
        assert [c.artifactId for c in globex_candidates] == [artifact_id]
        assert globex_candidates[0].uses == 1

    asyncio.run(run())


def test_same_tenant_cache_hit_no_duplicate_generated(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage)
        spec = l2_spec()

        await lineage.view_composed(spec=spec, trace=TRACE, surface="web", tenant="acme")
        await lineage.view_composed(
            spec=l2_spec(cache="hit"), trace=TRACE, surface="web", tenant="acme"
        )

        events = await storage.list_lineage(LineageFilter(tenant="acme"))
        assert _types(events).count("component.generated") == 1
        assert _types(events).count("component.used") == 2

    asyncio.run(run())


def test_component_used_and_generated_have_expected_tenants(tmp_path: Path) -> None:
    # Auxiliary: verify that FileStoragePort's tenant filter is consistent with lineage recording.
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage)
        await lineage.view_composed(spec=l2_spec(), trace=TRACE, surface="web", tenant="acme")
        acme = await storage.list_lineage(LineageFilter(tenant="acme"))
        assert len(acme) == 3
        assert await storage.list_lineage(LineageFilter(tenant="globex")) == []

    asyncio.run(run())


def test_generated_recorded_per_tenant_globex_uses_only_own(tmp_path: Path) -> None:
    # A supplement on the list-aggregation side of test_generated_recorded_per_tenant_even_on_cache_hit (globex's uses is 1).
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage)
        await lineage.view_composed(spec=l2_spec(), trace=TRACE, surface="web", tenant="acme")
        await lineage.view_composed(
            spec=l2_spec(cache="hit"), trace=TRACE, surface="web", tenant="globex"
        )
        promotions = create_promotions(lineage=lineage, storage=storage)
        acme = await promotions.list_candidates(tenant="acme")
        globex = await promotions.list_candidates(tenant="globex")
        assert acme[0].uses == 1
        assert globex[0].uses == 1

    asyncio.run(run())

"""Tests for FileStoragePort (using a temp directory — repository convention)."""

from __future__ import annotations

import asyncio
import json
import warnings
from pathlib import Path
from typing import Any

from kohaku.spec import (
    FixationRecord,
    LineageActor,
    LineageEventRecord,
    LineageFilter,
    Principal,
    PromotionState,
    UISpec,
)
from kohaku.storage import FileStoragePort, MemoryStoragePort


def _spec(data_version: str = "v1") -> UISpec:
    return UISpec.model_validate(
        {
            "kohaku": "0.2",
            "intent": {"canonical": "t.v", "params": {}, "hash": "sha256:" + "0" * 64},
            "dataVersion": data_version,
            "components": [{"id": "root", "type": "layout.stack", "props": {}}],
            "provenance": {"tier": "L0", "composedBy": "t", "cache": "miss"},
        }
    )


def _event(event_id: str, type_: str = "view.composed", **payload: Any) -> LineageEventRecord:
    return LineageEventRecord(
        id=event_id,
        ts=f"2026-07-17T00:00:0{event_id[-1]}Z",
        actor=LineageActor(kind="system"),
        type=type_,
        payload=payload,
    )


class TestSpecCache:
    def test_put_get_roundtrip(self, tmp_path: Path) -> None:
        async def run() -> None:
            port = FileStoragePort(tmp_path)
            await port.put_spec_cache("k1", _spec())
            got = await port.get_spec_cache("k1")
            assert got is not None and got.dataVersion == "v1"
            assert await port.get_spec_cache("nope") is None

        asyncio.run(run())

    def test_lru_eviction(self, tmp_path: Path) -> None:
        async def run() -> None:
            port = FileStoragePort(tmp_path)
            for i in range(501):
                await port.put_spec_cache(f"k{i}", _spec())
            assert await port.get_spec_cache("k0") is None  # the oldest is dropped
            assert await port.get_spec_cache("k500") is not None

        asyncio.run(run())


class TestLineage:
    def test_append_persists_and_filters(self, tmp_path: Path) -> None:
        async def run() -> None:
            port = FileStoragePort(tmp_path)
            await port.append_lineage(_event("e1", intentHash="sha256:aa"))
            await port.append_lineage(_event("e2", "view.rendered", intentHash="sha256:bb"))
            # confirm persistence by reloading
            port2 = FileStoragePort(tmp_path)
            events = await port2.list_lineage()
            assert [e.id for e in events] == ["e1", "e2"]
            filtered = await port2.list_lineage(LineageFilter(type=["view.composed"]))
            assert [e.id for e in filtered] == ["e1"]
            limited = await port2.list_lineage(LineageFilter(limit=1))
            assert [e.id for e in limited] == ["e2"]  # the latest limit items (tail)

        asyncio.run(run())

    def test_corrupt_jsonl_line_is_skipped(self, tmp_path: Path) -> None:
        (tmp_path / "lineage.jsonl").write_text('{"id":"ok","ts":"t","actor":{"kind":"system"},"type":"x","payload":{}}\n{broken\n')
        port = FileStoragePort(tmp_path)
        events = asyncio.run(port.list_lineage())
        assert [e.id for e in events] == ["ok"]


class TestPromotionAndFixation:
    def test_tenant_key_isolation(self, tmp_path: Path) -> None:
        async def run() -> None:
            port = FileStoragePort(tmp_path)
            await port.put_promotion_state(
                PromotionState(artifactId="a1", status="draft", updatedAt="t", tenant="t1")
            )
            await port.put_promotion_state(
                PromotionState(artifactId="a1", status="published", updatedAt="t", tenant="t2")
            )
            s1 = await port.get_promotion_state("a1", "t1")
            s2 = await port.get_promotion_state("a1", "t2")
            assert s1 is not None and s1.status == "draft"
            assert s2 is not None and s2.status == "published"
            assert await port.get_promotion_state("a1") is None  # the tenant-neutral key is separate
            assert len(await port.list_promotion_states("t1")) == 1

        asyncio.run(run())

    def test_fixation_roundtrip_and_delete(self, tmp_path: Path) -> None:
        async def run() -> None:
            port = FileStoragePort(tmp_path)
            record_hash = "sha256:" + "1" * 64

            await port.put_fixation(
                FixationRecord(
                    intentHash=record_hash,
                    canonical="t.v",
                    structureHash="sha256:" + "2" * 64,
                    pinnedSpec=_spec(),
                    fixatedAt="2026-07-17T00:00:00Z",
                    approver=Principal(id="admin"),
                )
            )
            # approver is output with its None fields (name/roles) omitted (wire-compatible with TS's undefined omission).
            on_disk = json.loads((tmp_path / "fixations.json").read_text(encoding="utf-8"))
            approver_wire = on_disk[record_hash]["approver"]
            assert approver_wire == {"id": "admin"}  # the name/roles keys are not output

            # confirm persistence + pinnedSpec restoration by reloading
            port2 = FileStoragePort(tmp_path)
            got = await port2.get_fixation(record_hash)
            assert got is not None and got.pinnedSpec.dataVersion == "v1"
            await port2.delete_fixation(record_hash)
            assert await port2.get_fixation(record_hash) is None

            # When name/roles are present, the keys are preserved and round-trip.
            record_hash2 = "sha256:" + "3" * 64
            await port2.put_fixation(
                FixationRecord(
                    intentHash=record_hash2,
                    canonical="t.v",
                    structureHash="sha256:" + "4" * 64,
                    pinnedSpec=_spec(),
                    fixatedAt="2026-07-17T00:00:00Z",
                    approver=Principal(id="ops", name="Operations", roles=["approver"]),
                )
            )
            on_disk2 = json.loads((tmp_path / "fixations.json").read_text(encoding="utf-8"))
            assert on_disk2[record_hash2]["approver"] == {
                "id": "ops",
                "name": "Operations",
                "roles": ["approver"],
            }
            got2 = await FileStoragePort(tmp_path).get_fixation(record_hash2)
            assert got2 is not None and got2.approver.name == "Operations"
            assert got2.approver.roles == ["approver"]

        asyncio.run(run())

    def test_corrupt_snapshot_recovers_from_memory(self, tmp_path: Path) -> None:
        async def run() -> None:
            port = FileStoragePort(tmp_path)
            await port.put_promotion_state(
                PromotionState(artifactId="a1", status="draft", updatedAt="t")
            )
            # Corrupt the disk then put again → recover from the memory base so a1 is not lost
            (tmp_path / "promotions.json").write_text("{broken")
            await port.put_promotion_state(
                PromotionState(artifactId="a2", status="draft", updatedAt="t")
            )
            data = json.loads((tmp_path / "promotions.json").read_text(encoding="utf-8"))
            assert set(data.keys()) == {"a1", "a2"}

        asyncio.run(run())

    def test_ifpresent_put_fixation_is_noop_when_absent(self, tmp_path: Path) -> None:
        """D-analogue of TS's ifPresent cross-instance test: a stale in-memory copy racing a concurrent
        delete (e.g. sample-api / sample-mcp sharing one data dir) must not resurrect the fixation."""

        async def run() -> None:
            record_hash = "sha256:" + "9" * 64
            port_a = FileStoragePort(tmp_path)
            await port_a.put_fixation(
                FixationRecord(
                    intentHash=record_hash,
                    canonical="t.v",
                    structureHash="sha256:" + "8" * 64,
                    pinnedSpec=_spec(),
                    fixatedAt="2026-07-17T00:00:00Z",
                    approver=Principal(id="admin"),
                )
            )
            port_b = FileStoragePort(tmp_path)  # loads the fixation into its own memory too
            assert await port_b.get_fixation(record_hash) is not None

            await port_a.delete_fixation(record_hash)
            assert await port_a.get_fixation(record_hash) is None

            # port_b's stale copy attempts an if_present-guarded refresh; since the key is absent from the
            # freshly re-read disk snapshot, the write is a no-op and does not resurrect it anywhere.
            stale = await FileStoragePort(tmp_path).get_fixation(record_hash)  # None on a fresh load too
            assert stale is None
            existing = FixationRecord(
                intentHash=record_hash,
                canonical="t.v",
                structureHash="sha256:" + "8" * 64,
                pinnedSpec=_spec(),
                fixatedAt="2026-07-17T00:00:00Z",
                approver=Principal(id="admin"),
                catalogFingerprint="fp-new",
            )
            await port_b.put_fixation(existing, if_present=True)

            assert await port_a.get_fixation(record_hash) is None
            assert await port_b.get_fixation(record_hash) is None
            assert await FileStoragePort(tmp_path).get_fixation(record_hash) is None

        asyncio.run(run())


class TestSnapshotEntryTolerance:
    """D4: a malformed *individual* record in promotions.json / fixations.json must not abort startup — only
    that entry is skipped (mirrors the TS port's pre-existing per-line tolerance in lineage.jsonl)."""

    def test_one_malformed_fixation_entry_is_skipped_others_load(self, tmp_path: Path) -> None:
        good_hash = "sha256:" + "1" * 64
        good = {
            "intentHash": good_hash,
            "canonical": "t.v",
            "structureHash": "sha256:" + "2" * 64,
            "pinnedSpec": _spec().to_wire(),
            "fixatedAt": "2026-07-17T00:00:00Z",
            "approver": {"id": "admin"},
        }
        broken = {"intentHash": "sha256:" + "3" * 64}  # missing pinnedSpec -> UISpec.model_validate raises
        (tmp_path / "fixations.json").write_text(
            json.dumps({good_hash: good, "sha256:broken": broken}), encoding="utf-8"
        )

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            port = FileStoragePort(tmp_path)

        assert any("skipped 1 malformed record" in str(w.message) for w in caught)
        got = asyncio.run(port.list_fixations())
        assert [f.intentHash for f in got] == [good_hash]

    def test_a_null_json_root_is_still_treated_as_corrupted(self, tmp_path: Path) -> None:
        (tmp_path / "promotions.json").write_text("null", encoding="utf-8")
        port = FileStoragePort(tmp_path)
        assert asyncio.run(port.list_promotion_states()) == []
        backups = list(tmp_path.glob("promotions.json.*.corrupt"))
        assert len(backups) == 1

    def test_an_array_json_root_is_still_treated_as_corrupted(self, tmp_path: Path) -> None:
        (tmp_path / "fixations.json").write_text("[]", encoding="utf-8")
        port = FileStoragePort(tmp_path)
        assert asyncio.run(port.list_fixations()) == []
        backups = list(tmp_path.glob("fixations.json.*.corrupt"))
        assert len(backups) == 1


class TestMemoryStoragePort:
    def test_temp_dir_created_used_and_cleaned_up(self) -> None:
        port = MemoryStoragePort()
        data_dir = port._dir
        assert data_dir.exists()
        # Not truly in-memory but backed by real files (reading/writing disposable files works).
        asyncio.run(port.append_lineage(_event("e1")))
        assert (data_dir / "lineage.jsonl").exists()
        # close() reclaims the temp directory (cleanup without waiting for GC; also safe to call multiple times).
        port.close()
        assert not data_dir.exists()
        port.close()  # idempotent (safe to call multiple times)

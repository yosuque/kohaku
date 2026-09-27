"""Fixations.replace tests (pytest port of packages/lineage/test/fixation-migrate.test.ts).

Storage is a tmp_path FileStoragePort, matching test_fixation.py's convention.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path

from kohaku.lineage import create_fixations, create_lineage
from kohaku.spec import FixationRecord, Principal, UISpec
from kohaku.storage import FileStoragePort

from ._helpers import l1_spec, l2_spec

APPROVER = Principal(id="reviewer-1")
INTENT_HASH = "sha256:" + "1" * 64  # shared by l1_spec() and l2_spec() (see _helpers.py)


@dataclass(frozen=True)
class _Cat:
    fingerprint: str


def _record(pinned: UISpec, **overrides: object) -> FixationRecord:
    base = FixationRecord(
        intentHash=INTENT_HASH,
        canonical="sales.custom",
        structureHash="sha256:" + "3" * 64,
        pinnedSpec=pinned,
        fixatedAt="2026-07-01T00:00:00Z",
        approver=Principal(id="tester"),
        revision="rev-1",
    )
    return FixationRecord(**{**base.__dict__, **overrides})


def test_replace_returns_none_and_records_nothing_when_absent(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)
        result = await fixations.replace("sha256:" + "9" * 64, l2_spec(), approver=APPROVER)
        assert result is None
        assert await storage.list_lineage() == []

    asyncio.run(run())


def test_replace_with_no_guard_unconditionally_replaces_and_records_intent_migrated(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await storage.put_fixation(_record(l1_spec()))
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        result = await fixations.replace(INTENT_HASH, l2_spec(), approver=APPROVER, plan_id="plan-1")
        assert result is not None
        stored = await storage.get_fixation(INTENT_HASH)
        assert stored is not None
        assert stored.pinnedSpec == l2_spec()

        events = await storage.list_lineage()
        assert len(events) == 1
        assert events[0].type == "intent.migrated"
        assert events[0].payload["intentHash"] == INTENT_HASH
        assert events[0].payload["planId"] == "plan-1"
        assert events[0].payload["approver"] == APPROVER.id
        assert events[0].actor.kind == "user"
        assert events[0].actor.id == APPROVER.id

    asyncio.run(run())


def test_replace_recomputes_structure_hash(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        original = _record(l1_spec())
        await storage.put_fixation(original)
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        result = await fixations.replace(INTENT_HASH, l2_spec(), approver=APPROVER)
        assert result is not None
        assert result.structureHash != original.structureHash
        stored = await storage.get_fixation(INTENT_HASH)
        assert stored is not None and stored.structureHash == result.structureHash

    asyncio.run(run())


def test_replace_stamps_a_fresh_revision(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await storage.put_fixation(_record(l1_spec(), revision="rev-old"))
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        result = await fixations.replace(INTENT_HASH, l2_spec(), approver=APPROVER)
        assert result is not None
        assert result.revision != "rev-old"

    asyncio.run(run())


def test_replace_preserves_intent_hash_canonical_and_tenant(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await storage.put_fixation(_record(l1_spec(), tenant="acme"))
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        result = await fixations.replace(INTENT_HASH, l2_spec(), approver=APPROVER, tenant="acme")
        assert result is not None
        assert result.intentHash == INTENT_HASH
        assert result.canonical == "sales.custom"
        assert result.tenant == "acme"

    asyncio.run(run())


def test_replace_restamps_catalog_fingerprint_when_wired(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await storage.put_fixation(_record(l1_spec(), catalogFingerprint="fp-old"))
        fixations = create_fixations(
            lineage=create_lineage(storage), storage=storage, catalog_for=lambda _t: _Cat("fp-new")
        )

        result = await fixations.replace(INTENT_HASH, l2_spec(), approver=APPROVER)
        assert result is not None
        assert result.catalogFingerprint == "fp-new"
        stored = await storage.get_fixation(INTENT_HASH)
        assert stored is not None and stored.catalogFingerprint == "fp-new"

    asyncio.run(run())


# --- TOCTOU guard ---


def test_replace_guard_if_revision_mismatch_does_not_replace(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await storage.put_fixation(_record(l1_spec(), revision="rev-new"))
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        result = await fixations.replace(
            INTENT_HASH, l2_spec(), approver=APPROVER, guard={"ifRevision": "rev-old"}
        )
        assert result is None
        stored = await storage.get_fixation(INTENT_HASH)
        assert stored is not None and stored.pinnedSpec == l1_spec()
        assert await storage.list_lineage() == []

    asyncio.run(run())


def test_replace_guard_if_revision_match_replaces(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await storage.put_fixation(_record(l1_spec(), revision="rev-1"))
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        result = await fixations.replace(
            INTENT_HASH, l2_spec(), approver=APPROVER, guard={"ifRevision": "rev-1"}
        )
        assert result is not None
        assert len(await storage.list_lineage()) == 1

    asyncio.run(run())


def test_replace_guard_if_fixated_at_mismatch_does_not_replace(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        record = _record(l1_spec(), fixatedAt="2026-08-01T00:00:00Z", revision=None)
        await storage.put_fixation(record)
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        result = await fixations.replace(
            INTENT_HASH, l2_spec(), approver=APPROVER, guard={"ifFixatedAt": "2026-07-01T00:00:00Z"}
        )
        assert result is None
        assert await storage.list_lineage() == []

    asyncio.run(run())


def test_replace_guard_if_catalog_fingerprint_mismatch_does_not_replace(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await storage.put_fixation(_record(l1_spec(), catalogFingerprint="fp-new"))
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        result = await fixations.replace(
            INTENT_HASH, l2_spec(), approver=APPROVER, guard={"ifCatalogFingerprint": "fp-old"}
        )
        assert result is None
        assert await storage.list_lineage() == []

    asyncio.run(run())


def test_replace_guard_if_structure_hash_mismatch_does_not_replace(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await storage.put_fixation(_record(l1_spec(), structureHash="sha256:" + "2" * 64))
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        result = await fixations.replace(
            INTENT_HASH, l2_spec(), approver=APPROVER, guard={"ifStructureHash": "sha256:" + "3" * 64}
        )
        assert result is None
        stored = await storage.get_fixation(INTENT_HASH)
        assert stored is not None and stored.pinnedSpec == l1_spec()
        assert await storage.list_lineage() == []

    asyncio.run(run())


def test_replace_guard_if_structure_hash_match_replaces(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        record = _record(l1_spec())
        await storage.put_fixation(record)
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        result = await fixations.replace(
            INTENT_HASH, l2_spec(), approver=APPROVER, guard={"ifStructureHash": record.structureHash}
        )
        assert result is not None
        assert len(await storage.list_lineage()) == 1

    asyncio.run(run())

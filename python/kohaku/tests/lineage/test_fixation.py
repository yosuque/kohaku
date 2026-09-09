"""Fixation tests (pytest port of the fixation cases in lineage.test.ts + fixation-invalidate-guard.test.ts).

Storage is a tmp_path FileStoragePort. The unsupported-deleteFixation case is reproduced with NoDeleteFixationStorage.
"""

from __future__ import annotations

import asyncio
import dataclasses
from dataclasses import dataclass
from pathlib import Path

import pytest

from kohaku.lineage import (
    FixationPolicy,
    FixationUnsupportedError,
    create_fixations,
    create_lineage,
)
from kohaku.spec import FixationRecord, LineageEventRecord, Principal, UISpec
from kohaku.storage import FileStoragePort

from ._helpers import NoDeleteFixationStorage, l2_spec, seed

APPROVER = Principal(id="admin")


@dataclass(frozen=True)
class _Cat:
    """A test catalog handle that satisfies SupportsFingerprint."""

    fingerprint: str


def _record(catalog_fingerprint: str | None = None, *, pinned: UISpec | None = None) -> FixationRecord:
    return FixationRecord(
        intentHash="sha256:" + "2" * 64,
        canonical="sales.trend",
        structureHash="sha256:" + "3" * 64,
        pinnedSpec=pinned if pinned is not None else l2_spec(),
        fixatedAt="2026-07-17T00:00:00Z",
        approver=APPROVER,
        catalogFingerprint=catalog_fingerprint,
    )


# --- Unfixation (unfixate) ---


def test_unfixate_fail_fast_when_delete_unsupported(tmp_path: Path) -> None:
    async def run() -> None:
        storage = NoDeleteFixationStorage(tmp_path)
        record = _record()
        await storage.put_fixation(record)
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        with pytest.raises(FixationUnsupportedError):
            await fixations.unfixate(record.intentHash, APPROVER)
        # Prevent the situation where the state cannot be deleted yet only the audit remains (intent.unfixated is not recorded)
        assert not any(e.type == "intent.unfixated" for e in await storage.list_lineage())

    asyncio.run(run())


def test_unfixate_deletes_and_records(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        record = _record()
        await storage.put_fixation(record)
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        await fixations.unfixate(record.intentHash, APPROVER)
        assert await storage.get_fixation(record.intentHash) is None
        assert any(e.type == "intent.unfixated" for e in await storage.list_lineage())

    asyncio.run(run())


def test_unfixate_absent_is_noop(tmp_path: Path) -> None:
    async def run() -> None:
        storage = NoDeleteFixationStorage(tmp_path)  # get_fixation is always None (empty)
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        await fixations.unfixate("sha256:" + "9" * 64, APPROVER)
        assert await storage.list_lineage() == []

    asyncio.run(run())


# --- Fixation staleness detection ---


def test_fixate_stamps_catalog_fingerprint(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        fixations = create_fixations(
            lineage=create_lineage(storage),
            storage=storage,
            catalog_for=lambda tenant: _Cat("fp-catalog-1"),
        )

        record = await fixations.fixate(pinned_spec=l2_spec(), approver=APPROVER)
        assert record.catalogFingerprint == "fp-catalog-1"
        got = await storage.get_fixation(record.intentHash)
        assert got is not None and got.catalogFingerprint == "fp-catalog-1"

    asyncio.run(run())


def test_fixate_without_catalog_no_stamp(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        record = await fixations.fixate(pinned_spec=l2_spec(), approver=APPROVER)
        # The dataclass always has a catalogFingerprint field, but when unstamped it is None (omitted in the wire form).
        assert record.catalogFingerprint is None

    asyncio.run(run())


def test_invalidate_deletes_then_records_system_stale(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        record = _record("fp-old")
        await storage.put_fixation(record)
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        await fixations.invalidate(
            record.intentHash, "stale", "md1: type ... is not in the catalog"
        )

        # The state is deleted first
        assert await storage.get_fixation(record.intentHash) is None
        # After success, a system-actor audit event (with reason / detail)
        unfixated = [e for e in await storage.list_lineage() if e.type == "intent.unfixated"]
        assert len(unfixated) == 1
        assert unfixated[0].actor.kind == "system"
        assert unfixated[0].payload["reason"] == "stale"
        assert "catalog" in unfixated[0].payload["detail"]
        # Since this is self-healing, do not stamp approver (distinguished from human-approved unfixate)
        assert "approver" not in unfixated[0].payload

    asyncio.run(run())


def test_invalidate_fail_fast_when_delete_unsupported(tmp_path: Path) -> None:
    async def run() -> None:
        storage = NoDeleteFixationStorage(tmp_path)
        record = _record("fp-old")
        await storage.put_fixation(record)
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        with pytest.raises(FixationUnsupportedError):
            await fixations.invalidate(record.intentHash, "stale")
        assert not any(e.type == "intent.unfixated" for e in await storage.list_lineage())

    asyncio.run(run())


def test_invalidate_absent_is_noop(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)  # get_fixation is always None (empty)
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        await fixations.invalidate("sha256:" + "9" * 64, "stale")
        assert await storage.list_lineage() == []

    asyncio.run(run())


def test_refresh_fingerprint_overwrites_only(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        record = _record("fp-old")
        await storage.put_fixation(record)
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        await fixations.refresh_fingerprint(record.intentHash, "fp-new")

        got = await storage.get_fixation(record.intentHash)
        assert got is not None and got.catalogFingerprint == "fp-new"
        # Resolving staleness is not a governance decision, so no event is recorded
        assert await storage.list_lineage() == []

    asyncio.run(run())


def test_refresh_fingerprint_absent_is_noop(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        await fixations.refresh_fingerprint("sha256:" + "9" * 64, "fp-new")
        assert await storage.list_lineage() == []

    asyncio.run(run())


# --- invalidate's TOCTOU guard (fixation-invalidate-guard.test.ts) ---


def test_invalidate_guard_mismatch_skips(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        record = _record("fp-new")
        await storage.put_fixation(record)
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        await fixations.invalidate(
            record.intentHash, "stale", None, None, {"ifCatalogFingerprint": "fp-old"}
        )
        assert await storage.get_fixation(record.intentHash) is not None
        assert await storage.list_lineage() == []

    asyncio.run(run())


def test_invalidate_guard_match_deletes(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        record = _record("fp-old")
        await storage.put_fixation(record)
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        await fixations.invalidate(
            record.intentHash, "stale", "verification failed", None, {"ifCatalogFingerprint": "fp-old"}
        )
        assert await storage.get_fixation(record.intentHash) is None
        assert _types_of(await storage.list_lineage()) == ["intent.unfixated"]

    asyncio.run(run())


def test_invalidate_no_guard_unconditional_delete(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        record = _record("fp-any")
        await storage.put_fixation(record)
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        await fixations.invalidate(record.intentHash, "stale")
        assert await storage.get_fixation(record.intentHash) is None
        assert _types_of(await storage.list_lineage()) == ["intent.unfixated"]

    asyncio.run(run())


def test_invalidate_guard_fixated_at_mismatch_skips(tmp_path: Path) -> None:
    """A legacy record with no catalogFingerprint (re-approved between the stale judgment and the delete
    call, so its fixatedAt changed) is still protected by the ifFixatedAt guard alone."""

    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        record = _record(None)  # no catalogFingerprint
        await storage.put_fixation(record)
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        await fixations.invalidate(
            record.intentHash, "stale", None, None, {"ifFixatedAt": "2026-01-01T00:00:00Z"}
        )
        assert await storage.get_fixation(record.intentHash) is not None
        assert await storage.list_lineage() == []

    asyncio.run(run())


def test_invalidate_guard_fixated_at_match_deletes(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        record = _record(None)  # no catalogFingerprint
        await storage.put_fixation(record)
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        await fixations.invalidate(
            record.intentHash, "stale", None, None, {"ifFixatedAt": record.fixatedAt}
        )
        assert await storage.get_fixation(record.intentHash) is None
        assert _types_of(await storage.list_lineage()) == ["intent.unfixated"]

    asyncio.run(run())


# --- invalidate's guard: ifRevision takes priority over ifFixatedAt ---


def test_invalidate_guard_revision_mismatch_skips_even_if_fixated_at_matches(tmp_path: Path) -> None:
    """A re-approved fixation that lands in the same millisecond as the judged one shares the same
    fixatedAt but gets a fresh revision — ifRevision must be checked (and take priority) so ifFixatedAt
    alone does not falsely match."""

    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        record = dataclasses.replace(_record(None), revision="rev-new")
        await storage.put_fixation(record)
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        await fixations.invalidate(
            record.intentHash,
            "stale",
            None,
            None,
            {"ifRevision": "rev-old", "ifFixatedAt": record.fixatedAt},
        )
        assert await storage.get_fixation(record.intentHash) is not None
        assert await storage.list_lineage() == []

    asyncio.run(run())


def test_invalidate_guard_revision_match_deletes(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        record = dataclasses.replace(_record(None), revision="rev-1")
        await storage.put_fixation(record)
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        await fixations.invalidate(
            record.intentHash,
            "stale",
            None,
            None,
            {"ifRevision": "rev-1", "ifFixatedAt": record.fixatedAt},
        )
        assert await storage.get_fixation(record.intentHash) is None
        assert _types_of(await storage.list_lineage()) == ["intent.unfixated"]

    asyncio.run(run())


def test_fixate_stamps_a_revision(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)
        record = await fixations.fixate(pinned_spec=l2_spec(), approver=APPROVER)
        assert record.revision is not None and record.revision != ""

    asyncio.run(run())


# --- Tenant scoping of frequently-used Intent fixation candidates (proposals) ---


def test_proposals_tenant_scoped(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        fixations = create_fixations(
            lineage=create_lineage(storage),
            storage=storage,
            policy=FixationPolicy(minUses=2, minDistinctSessions=1, structuralStability=0.9),
        )
        for s in ("s1", "s2"):
            await seed(
                storage,
                "view.composed",
                {
                    "tier": "L1",
                    "intentHash": "hA",
                    "canonical": "sales.a",
                    "sessionId": s,
                    "structureHash": "st",
                },
                tenant="acme",
            )
        for s in ("s3", "s4"):
            await seed(
                storage,
                "view.composed",
                {
                    "tier": "L1",
                    "intentHash": "hB",
                    "canonical": "sales.b",
                    "sessionId": s,
                    "structureHash": "st",
                },
                tenant="globex",
            )

        acme = await fixations.proposals(tenant="acme")
        assert [p.intentHash for p in acme] == ["hA"]
        all_proposals = await fixations.proposals()
        assert sorted(p.intentHash for p in all_proposals) == ["hA", "hB"]

    asyncio.run(run())


def _types_of(records: list[LineageEventRecord]) -> list[str]:
    return [e.type for e in records]

"""Compare-and-set (StoragePort.supports_compare_and_set) for the file and memory ports.

Mirrors the `compare-and-set (optional extension)` group of the TS port-contracts suite
(packages/port-contracts/src/storage.ts, `requireCompareAndSet`), run against both reference ports; the file
port additionally compares against the snapshot re-read from disk, so two ports on one directory behave like
two host instances (the second half of this module).
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest

from kohaku.spec import (
    UNSET,
    FixationRecord,
    Principal,
    PromotionState,
    StorageConflictError,
    UISpec,
    is_single_process,
    supports_compare_and_set,
)
from kohaku.storage import FileStoragePort, MemoryStoragePort


def _spec() -> UISpec:
    return UISpec.model_validate(
        {
            "kohaku": "0.2",
            "intent": {"canonical": "t.v", "params": {}, "hash": "sha256:" + "0" * 64},
            "dataVersion": "v1",
            "components": [{"id": "root", "type": "layout.stack", "props": {}}],
            "provenance": {"tier": "L0", "composedBy": "t", "cache": "miss"},
        }
    )


def _promotion(
    artifact_id: str,
    tenant: str | None = None,
    revision: str | None = None,
    status: str = "candidate",
) -> PromotionState:
    return PromotionState(
        artifactId=artifact_id,
        status=status,
        updatedAt="2026-01-01T00:00:00.000Z",
        data={},
        tenant=tenant,
        revision=revision,
    )


def _fixation(
    intent_hash: str, tenant: str | None = None, revision: str | None = None
) -> FixationRecord:
    return FixationRecord(
        intentHash=intent_hash,
        canonical="contract.intent",
        structureHash="sha256:contract",
        pinnedSpec=_spec(),
        fixatedAt="2026-01-01T00:00:00.000Z",
        approver=Principal(id="contract"),
        tenant=tenant,
        revision=revision,
    )


async def _promo(port: Any, artifact_id: str, tenant: str | None = None) -> PromotionState:
    """get_promotion_state for a record the test knows exists (narrows the Optional for mypy)."""
    state = await port.get_promotion_state(artifact_id, tenant)
    assert state is not None
    return state  # type: ignore[no-any-return]


async def _fix(port: Any, intent_hash: str, tenant: str | None = None) -> FixationRecord:
    """get_fixation for a record the test knows exists (narrows the Optional for mypy)."""
    record = await port.get_fixation(intent_hash, tenant)
    assert record is not None
    return record  # type: ignore[no-any-return]


async def _expect_conflict(awaitable: Awaitable[object]) -> None:
    with pytest.raises(StorageConflictError) as info:
        await awaitable
    assert info.value.code == "STORAGE_CONFLICT"


async def _race(*calls: Awaitable[object]) -> tuple[int, int]:
    """Settles concurrent writes and returns (succeeded, conflicted); any other failure propagates."""
    settled = await asyncio.gather(*calls, return_exceptions=True)
    ok = conflict = 0
    for result in settled:
        if isinstance(result, StorageConflictError):
            conflict += 1
        elif isinstance(result, BaseException):
            raise result
        else:
            ok += 1
    return ok, conflict


PortFactory = Callable[[Path], Any]


@pytest.fixture(params=["file", "memory"])
def make_port(request: pytest.FixtureRequest) -> PortFactory:
    def factory(tmp_path: Path) -> Any:
        return FileStoragePort(tmp_path) if request.param == "file" else MemoryStoragePort()

    return factory


class TestCompareAndSetContract:
    def test_memory_port_declares_supports_compare_and_set(self) -> None:
        port = MemoryStoragePort()
        assert port.supports_compare_and_set is True
        assert supports_compare_and_set(port) is True
        assert is_single_process(port) is True

    def test_file_port_honors_expected_revision_but_does_not_declare_the_extension(
        self, tmp_path: Path
    ) -> None:
        # Its lock is in-process only and two processes may share one data directory, so it claims
        # single_process instead (hosts do not warn about it, and the lineage services do not pass the option).
        port = FileStoragePort(tmp_path)
        assert supports_compare_and_set(port) is False
        assert is_single_process(port) is True

    def test_supports_compare_and_set_is_a_strict_check(self) -> None:
        assert supports_compare_and_set(object()) is False

        class Truthy:
            supports_compare_and_set = "yes"

        assert supports_compare_and_set(Truthy()) is False

    def test_put_promotion_state_exact_succeeds_and_stale_conflicts_without_writing(
        self, tmp_path: Path, make_port: PortFactory
    ) -> None:
        async def run() -> None:
            port = make_port(tmp_path)
            await port.put_promotion_state(_promotion("x", "a", "r1"), expected_revision=None)
            await port.put_promotion_state(
                _promotion("x", "a", "r2", status="approved"), expected_revision="r1"
            )
            assert (await _promo(port, "x", "a")).revision == "r2"
            await _expect_conflict(
                port.put_promotion_state(
                    _promotion("x", "a", "r3", status="rejected"), expected_revision="r1"
                )
            )
            stored = await port.get_promotion_state("x", "a")
            assert (stored.revision, stored.status) == ("r2", "approved")

        asyncio.run(run())

    def test_put_promotion_state_none_means_must_not_exist(
        self, tmp_path: Path, make_port: PortFactory
    ) -> None:
        async def run() -> None:
            port = make_port(tmp_path)
            await port.put_promotion_state(_promotion("x", "a", "r1"), expected_revision=None)
            await _expect_conflict(
                port.put_promotion_state(_promotion("x", "a", "r2"), expected_revision=None)
            )
            assert (await _promo(port, "x", "a")).revision == "r1"
            # Another tenant's state is a different key, so None is satisfied there.
            await port.put_promotion_state(_promotion("x", "b", "r1"), expected_revision=None)

        asyncio.run(run())

    def test_put_promotion_state_str_expectation_against_absent_conflicts_and_creates_nothing(
        self, tmp_path: Path, make_port: PortFactory
    ) -> None:
        async def run() -> None:
            port = make_port(tmp_path)
            await _expect_conflict(
                port.put_promotion_state(_promotion("x", "a", "r2"), expected_revision="r1")
            )
            assert await port.get_promotion_state("x", "a") is None

        asyncio.run(run())

    def test_put_promotion_state_unset_stays_unconditional_including_over_a_legacy_record(
        self, tmp_path: Path, make_port: PortFactory
    ) -> None:
        async def run() -> None:
            port = make_port(tmp_path)
            await port.put_promotion_state(_promotion("x", "a"))  # predates `revision`
            await port.put_promotion_state(_promotion("x", "a", "r1"), expected_revision=UNSET)
            await port.put_promotion_state(_promotion("x", "a", "r2"))
            assert (await _promo(port, "x", "a")).revision == "r2"
            # A str expectation never matches a record that carries no revision.
            await port.put_promotion_state(_promotion("y", "a"))
            await _expect_conflict(
                port.put_promotion_state(_promotion("y", "a", "r2"), expected_revision="r1")
            )

        asyncio.run(run())

    def test_put_promotion_state_of_two_concurrent_writes_exactly_one_wins(
        self, tmp_path: Path, make_port: PortFactory
    ) -> None:
        async def run() -> None:
            port = make_port(tmp_path)
            await port.put_promotion_state(_promotion("x", "a", "r1"))
            outcome = await _race(
                port.put_promotion_state(
                    _promotion("x", "a", "rA", status="approved"), expected_revision="r1"
                ),
                port.put_promotion_state(
                    _promotion("x", "a", "rB", status="rejected"), expected_revision="r1"
                ),
            )
            assert outcome == (1, 1)
            stored = await port.get_promotion_state("x", "a")
            assert stored.status == ("approved" if stored.revision == "rA" else "rejected")

        asyncio.run(run())

    def test_put_fixation_exact_succeeds_and_stale_conflicts_without_writing(
        self, tmp_path: Path, make_port: PortFactory
    ) -> None:
        async def run() -> None:
            port = make_port(tmp_path)
            await port.put_fixation(_fixation("h", "a", "r1"), expected_revision=None)
            await port.put_fixation(_fixation("h", "a", "r2"), expected_revision="r1")
            assert (await _fix(port, "h", "a")).revision == "r2"
            await _expect_conflict(
                port.put_fixation(_fixation("h", "a", "r3"), expected_revision="r1")
            )
            assert (await _fix(port, "h", "a")).revision == "r2"

        asyncio.run(run())

    def test_put_fixation_none_conflicts_with_existing_and_str_conflicts_with_absent(
        self, tmp_path: Path, make_port: PortFactory
    ) -> None:
        async def run() -> None:
            port = make_port(tmp_path)
            await _expect_conflict(
                port.put_fixation(_fixation("h", "a", "r2"), expected_revision="r1")
            )
            assert await port.get_fixation("h", "a") is None
            await port.put_fixation(_fixation("h", "a", "r1"), expected_revision=None)
            await _expect_conflict(
                port.put_fixation(_fixation("h", "a", "r2"), expected_revision=None)
            )
            assert (await _fix(port, "h", "a")).revision == "r1"

        asyncio.run(run())

    def test_put_fixation_if_present_combines_with_expected_revision(
        self, tmp_path: Path, make_port: PortFactory
    ) -> None:
        async def run() -> None:
            port = make_port(tmp_path)
            # Absent: if_present wins, so even a str expectation is a no-op rather than a conflict.
            await port.put_fixation(
                _fixation("h", "a", "r2"), if_present=True, expected_revision="r1"
            )
            assert await port.get_fixation("h", "a") is None
            # Present: the revision is compared.
            await port.put_fixation(_fixation("h", "a", "r1"))
            await port.put_fixation(
                _fixation("h", "a", "r2"), if_present=True, expected_revision="r1"
            )
            assert (await _fix(port, "h", "a")).revision == "r2"
            await _expect_conflict(
                port.put_fixation(
                    _fixation("h", "a", "r3"), if_present=True, expected_revision="r1"
                )
            )
            assert (await _fix(port, "h", "a")).revision == "r2"

        asyncio.run(run())

    def test_put_fixation_if_present_with_none_is_contradictory_and_always_conflicts(
        self, tmp_path: Path, make_port: PortFactory
    ) -> None:
        async def run() -> None:
            port = make_port(tmp_path)
            await _expect_conflict(
                port.put_fixation(
                    _fixation("h", "a", "r1"), if_present=True, expected_revision=None
                )
            )
            await port.put_fixation(_fixation("h", "a", "r1"))
            await _expect_conflict(
                port.put_fixation(
                    _fixation("h", "a", "r2"), if_present=True, expected_revision=None
                )
            )
            assert (await _fix(port, "h", "a")).revision == "r1"

        asyncio.run(run())

    def test_put_fixation_of_two_concurrent_writes_exactly_one_wins(
        self, tmp_path: Path, make_port: PortFactory
    ) -> None:
        async def run() -> None:
            port = make_port(tmp_path)
            await port.put_fixation(_fixation("h", "a", "r1"))
            outcome = await _race(
                port.put_fixation(_fixation("h", "a", "rA"), expected_revision="r1"),
                port.put_fixation(_fixation("h", "a", "rB"), expected_revision="r1"),
            )
            assert outcome == (1, 1)

        asyncio.run(run())

    def test_delete_fixation_deletes_on_a_match_and_conflicts_on_a_mismatch(
        self, tmp_path: Path, make_port: PortFactory
    ) -> None:
        async def run() -> None:
            port = make_port(tmp_path)
            await port.put_fixation(_fixation("h", "a", "r1"))
            await _expect_conflict(port.delete_fixation("h", "a", expected_revision="r0"))
            assert await port.get_fixation("h", "a") is not None
            await port.delete_fixation("h", "a", expected_revision="r1")
            assert await port.get_fixation("h", "a") is None

        asyncio.run(run())

    def test_delete_fixation_str_expectation_against_absent_conflicts_without_one_it_is_a_noop(
        self, tmp_path: Path, make_port: PortFactory
    ) -> None:
        async def run() -> None:
            port = make_port(tmp_path)
            await _expect_conflict(port.delete_fixation("h", "a", expected_revision="r1"))
            await port.delete_fixation("h", "a")

        asyncio.run(run())

    def test_delete_and_write_from_the_same_base_cannot_both_land(
        self, tmp_path: Path, make_port: PortFactory
    ) -> None:
        async def run() -> None:
            port = make_port(tmp_path)
            await port.put_fixation(_fixation("h", "a", "r1"))
            outcome = await _race(
                port.delete_fixation("h", "a", expected_revision="r1"),
                port.put_fixation(_fixation("h", "a", "r2"), expected_revision="r1"),
            )
            assert outcome == (1, 1)

        asyncio.run(run())

    def test_scopes_the_check_by_tenant(self, tmp_path: Path, make_port: PortFactory) -> None:
        async def run() -> None:
            port = make_port(tmp_path)
            await port.put_fixation(_fixation("h", "a", "r1"))
            await port.put_fixation(_fixation("h", "b", "r9"))
            await port.put_fixation(_fixation("h", "a", "r2"), expected_revision="r1")
            assert (await _fix(port, "h", "b")).revision == "r9"

        asyncio.run(run())

    def test_the_revision_survives_a_restart(self, tmp_path: Path) -> None:
        async def run() -> None:
            port = FileStoragePort(tmp_path)
            await port.put_promotion_state(_promotion("x", None, "r1"))
            await port.put_fixation(_fixation("h", None, "f1"))
            reloaded = FileStoragePort(tmp_path)
            assert (await _promo(reloaded, "x")).revision == "r1"
            await reloaded.put_promotion_state(_promotion("x", None, "r2"), expected_revision="r1")
            await reloaded.delete_fixation("h", expected_revision="f1")

        asyncio.run(run())


class TestCompareAndSetAcrossInstances:
    """Two FileStoragePorts on one directory stand in for two host instances: they share no in-process lock
    or memory, so the comparison against the snapshot re-read from disk is what decides the race."""

    def test_a_write_based_on_a_stale_in_memory_copy_conflicts_and_refreshes_the_view(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            a = FileStoragePort(tmp_path)
            await a.put_promotion_state(_promotion("x", None, "r1"))
            b2 = FileStoragePort(tmp_path)  # b2 loads r1 into its memory
            assert (await _promo(b2, "x")).revision == "r1"
            await a.put_promotion_state(_promotion("x", None, "r2"), expected_revision="r1")

            # b2's memory still says r1, the disk says r2: the CAS decides on the disk.
            await _expect_conflict(
                b2.put_promotion_state(_promotion("x", None, "r3"), expected_revision="r1")
            )
            # The rejected write refreshed b2's stale view from the re-read.
            assert (await _promo(b2, "x")).revision == "r2"

        asyncio.run(run())

    def test_a_conflicting_delete_refreshes_the_view_too(self, tmp_path: Path) -> None:
        async def run() -> None:
            a = FileStoragePort(tmp_path)
            await a.put_fixation(_fixation("h", None, "f1"))
            b = FileStoragePort(tmp_path)
            await a.put_fixation(_fixation("h", None, "f2"), expected_revision="f1")
            await _expect_conflict(b.delete_fixation("h", expected_revision="f1"))
            assert (await _fix(b, "h")).revision == "f2"

        asyncio.run(run())

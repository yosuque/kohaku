"""Storage-boundary validation of persisted fixation / promotion-state records (§4.3 A10 of the 2026-09
review; pytest port of the TS test packages/lineage/test/storage-record-validation.test.ts).

A FixationRecord / PromotionState read back from StoragePort has no runtime guarantee of matching its
declared shape (a corrupted or hand-edited fixations.json / promotions.json entry, or a non-conforming
StoragePort implementation). kohaku.lineage's Fixations service (unfixate / invalidate / refresh_fingerprint)
and Promotions._load_candidate (exercised here via Promotions.get) run every record they read through
kohaku.spec.validate_fixation_record / validate_promotion_state and treat a validation failure exactly like a
real absence, reporting it via the service's on_error hook.

Deliberately uses a minimal FileStoragePort subclass that overrides a single read method, rather than the
repository's usual tmp_path FileStoragePort round-trip (see ._helpers's docstring): FileStoragePort's own
_fixation_from_wire already validates pinnedSpec via UISpec.model_validate at load time (and _load_records
skips a malformed on-disk entry before it ever becomes a get_fixation() result), so a genuinely corrupted
FixationRecord cannot be produced by writing a bad file and reading it back through FileStoragePort's normal
path — the scenario under test (a non-conforming record reaching the Fixations/Promotions read boundary) has
to be injected directly.

The delivery-path read (host.lookup -> composer.materialize_fixation) is validated independently by the
composer (python/kohaku/tests/composer/test_fixation.py's test_stale_when_pinned_spec_is_corrupted) — it
never routes through kohaku.lineage's Fixations service.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, cast

from kohaku.lineage import (
    FixationErrorContext,
    PromotionErrorContext,
    create_fixations,
    create_lineage,
    create_promotions,
)
from kohaku.spec import (
    FixationRecord,
    LineageActor,
    LineageEventRecord,
    Principal,
    PromotionState,
    UISpec,
)
from kohaku.storage import FileStoragePort

from ._helpers import l2_spec

APPROVER = Principal(id="admin")
HASH = "sha256:" + "2" * 64


def _corrupted_fixation_record() -> FixationRecord:
    """A FixationRecord whose pinnedSpec fails UISpec's own schema (empty components). Constructed via the
    dataclass directly (bypassing UISpec.model_validate), simulating what a non-conforming StoragePort
    implementation (or a corrupted on-disk record read by one that skips validation) could return."""
    pinned_wire = l2_spec().to_wire()
    pinned_wire["components"] = []
    return FixationRecord(
        intentHash=HASH,
        canonical="sales.trend",
        structureHash="sha256:" + "3" * 64,
        pinnedSpec=cast(UISpec, pinned_wire),
        fixatedAt="2026-07-17T00:00:00Z",
        approver=APPROVER,
    )


class _CorruptedFixationStorage(FileStoragePort):
    """Returns a fixed, schema-invalid FixationRecord from get_fixation regardless of what is on disk."""

    def __init__(self, data_dir: Path, corrupted: FixationRecord) -> None:
        super().__init__(data_dir)
        self._corrupted = corrupted

    async def get_fixation(self, intent_hash: str, tenant: str | None = None) -> FixationRecord | None:
        return self._corrupted


def test_unfixate_treats_corrupted_record_as_absent_and_reports(tmp_path: Path) -> None:
    async def run() -> None:
        storage = _CorruptedFixationStorage(tmp_path, _corrupted_fixation_record())
        errors: list[tuple[FixationErrorContext, BaseException]] = []
        fixations = create_fixations(
            lineage=create_lineage(storage),
            storage=storage,
            on_error=lambda ctx, error: errors.append((ctx, error)),
        )

        await fixations.unfixate(HASH, APPROVER)

        assert len(errors) == 1
        assert errors[0][0].endpoint == "storage.record.invalid"
        assert errors[0][0].intentHash == HASH

    asyncio.run(run())


def test_invalidate_treats_corrupted_record_as_absent_and_reports(tmp_path: Path) -> None:
    async def run() -> None:
        storage = _CorruptedFixationStorage(tmp_path, _corrupted_fixation_record())
        errors: list[tuple[FixationErrorContext, BaseException]] = []
        fixations = create_fixations(
            lineage=create_lineage(storage),
            storage=storage,
            on_error=lambda ctx, error: errors.append((ctx, error)),
        )

        await fixations.invalidate(HASH, "stale")

        assert len(errors) == 1
        assert errors[0][0].endpoint == "storage.record.invalid"
        assert errors[0][0].intentHash == HASH

    asyncio.run(run())


def test_refresh_fingerprint_treats_corrupted_record_as_absent_and_reports(tmp_path: Path) -> None:
    async def run() -> None:
        storage = _CorruptedFixationStorage(tmp_path, _corrupted_fixation_record())
        errors: list[tuple[FixationErrorContext, BaseException]] = []
        fixations = create_fixations(
            lineage=create_lineage(storage),
            storage=storage,
            on_error=lambda ctx, error: errors.append((ctx, error)),
        )

        await fixations.refresh_fingerprint(HASH, "sha256:new-fingerprint")

        assert len(errors) == 1
        assert errors[0][0].endpoint == "storage.record.invalid"
        assert errors[0][0].intentHash == HASH

    asyncio.run(run())


def test_no_on_error_wired_is_silent_fail_open(tmp_path: Path) -> None:
    async def run() -> None:
        storage = _CorruptedFixationStorage(tmp_path, _corrupted_fixation_record())
        fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

        # Must not raise: a validation failure with no on_error hook is silently fail-open.
        await fixations.unfixate(HASH, APPROVER)

    asyncio.run(run())


class _CorruptedPromotionStorage(FileStoragePort):
    """Returns a fixed, schema-invalid PromotionState from get_promotion_state regardless of what is on disk."""

    def __init__(self, data_dir: Path, corrupted: PromotionState) -> None:
        super().__init__(data_dir)
        self._corrupted = corrupted

    async def get_promotion_state(
        self, artifact_id: str, tenant: str | None = None
    ) -> PromotionState | None:
        return self._corrupted


def test_load_candidate_treats_corrupted_state_as_absent_and_falls_back_to_in_use(tmp_path: Path) -> None:
    async def run() -> None:
        # data is not an object (a corrupted record) — status/updatedAt/artifactId being plain strings
        # would otherwise round-trip unchanged through PromotionState's dataclass, so `data` is the one
        # field a corrupted on-disk record could plausibly break without FileStoragePort's own (very
        # loose) _promotion_from_wire silently coercing it back into a valid shape.
        corrupted = PromotionState(
            artifactId="art1", status="in_use", updatedAt="2026-07-17T00:00:00Z", data=cast(Any, "not-an-object")
        )
        storage = _CorruptedPromotionStorage(tmp_path, corrupted)
        await storage.append_lineage(
            LineageEventRecord(
                id="e1",
                ts="2026-07-17T00:00:00Z",
                actor=LineageActor(kind="system"),
                type="component.generated",
                payload={"artifactId": "art1", "canonical": "sales.trend", "html": "<div>x</div>"},
            )
        )
        errors: list[tuple[PromotionErrorContext, BaseException]] = []
        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            on_error=lambda ctx, error: errors.append((ctx, error)),
        )

        candidate = await promotions.get("art1")

        assert candidate is not None
        assert candidate.status == "in_use"
        assert len(errors) == 1
        assert errors[0][0].endpoint == "storage.record.invalid"
        assert errors[0][0].artifactId == "art1"

    asyncio.run(run())


def test_load_candidate_no_on_error_wired_is_silent_fail_open(tmp_path: Path) -> None:
    async def run() -> None:
        corrupted = PromotionState(
            artifactId="art1", status="in_use", updatedAt="2026-07-17T00:00:00Z", data=cast(Any, "not-an-object")
        )
        storage = _CorruptedPromotionStorage(tmp_path, corrupted)
        await storage.append_lineage(
            LineageEventRecord(
                id="e1",
                ts="2026-07-17T00:00:00Z",
                actor=LineageActor(kind="system"),
                type="component.generated",
                payload={"artifactId": "art1", "canonical": "sales.trend", "html": "<div>x</div>"},
            )
        )
        promotions = create_promotions(lineage=create_lineage(storage), storage=storage)

        candidate = await promotions.get("art1")

        assert candidate is not None
        assert candidate.status == "in_use"

    asyncio.run(run())

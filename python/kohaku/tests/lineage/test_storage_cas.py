"""The lineage services against a compare-and-set StoragePort (`supports_compare_and_set`).

Python mirror of packages/lineage/test/storage-cas.test.ts: promotion and fixation writes carry the revision
they read, a concurrent writer's change surfaces as a StorageConflictError, and the loser never overwrites it.
The storage is a FileStoragePort subclass (a real CAS port) whose one-shot hooks land "another instance's"
write at an exact point of the service's read -> write sequence, by writing through the same object.
"""

from __future__ import annotations

import asyncio
import dataclasses
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest

from kohaku.lineage import (
    ComponentDraft,
    JudgeResult,
    JudgeStart,
    Nominate,
    PromotionPolicy,
    PublishContext,
    ReviewApprove,
    ValidatePublishContext,
    create_fixations,
    create_lineage,
    create_promotions,
)
from kohaku.spec import (
    UNSET,
    ExpectedDeleteRevision,
    ExpectedRevision,
    FixationRecord,
    LineageEventRecord,
    LineageFilter,
    Principal,
    PromotionState,
    StorageConflictError,
    UISpec,
)
from kohaku.storage import FileStoragePort

from ._helpers import l1_spec, l2_spec, seed

HASH = "sha256:" + "2" * 64
ACTOR = Principal(id="admin-1")
DRAFT = ComponentDraft(
    componentType="sales.customX",
    version="1.0.0",
    intentName="sales.customX",
    description="test draft",
)

Hook = Callable[[], Awaitable[None]]


def _pinned(marker: str) -> UISpec:
    base = l2_spec()
    return base.model_copy(update={"dataVersion": marker})


def _fixation(marker: str, revision: str | None = None, fingerprint: str = "fp1") -> FixationRecord:
    return FixationRecord(
        intentHash=HASH,
        canonical="sales.trend",
        structureHash="sha256:" + "3" * 64,
        pinnedSpec=_pinned(marker),
        fixatedAt="2026-07-01T00:00:00Z",
        approver=Principal(id="tester"),
        catalogFingerprint=fingerprint,
        revision=revision,
    )


class _CasStorage(FileStoragePort):
    """A recording CAS port. `hooks` are one-shot async callables fired at exact points; the "other writer"
    they simulate writes through `super()` so it lands on disk and in this port's memory like a concurrent
    writer's change would."""

    def __init__(self, data_dir: Path, *, declares_cas: bool = True) -> None:
        super().__init__(data_dir)
        # The file port does not declare the extension itself (its lock is in-process only); this test double
        # stands in for a real CAS adapter, or for one that has not adopted the extension.
        self.supports_compare_and_set = declares_cas
        self.promotion_writes: list[tuple[PromotionState, ExpectedRevision]] = []
        self.fixation_writes: list[tuple[FixationRecord, bool, ExpectedRevision]] = []
        self.fixation_deletes: list[ExpectedDeleteRevision] = []
        self.hooks: dict[str, Hook] = {}

    async def _fire(self, name: str) -> None:
        hook = self.hooks.pop(name, None)
        if hook is not None:
            await hook()

    async def append_lineage(self, event: LineageEventRecord) -> None:
        if event.type == "component.reviewed":
            await self._fire("before_reviewed_append")
        await super().append_lineage(event)

    async def list_lineage(self, filter: LineageFilter | None = None) -> list[LineageEventRecord]:
        result = await super().list_lineage(filter)
        if filter is not None and filter.type is not None and "component.generated" in filter.type:
            await self._fire("after_generated_lookup")
        return result

    async def get_fixation(
        self, intent_hash: str, tenant: str | None = None
    ) -> FixationRecord | None:
        result = await super().get_fixation(intent_hash, tenant)
        await self._fire("after_fixation_read")
        return result

    async def get_promotion_state(
        self, artifact_id: str, tenant: str | None = None
    ) -> PromotionState | None:
        result = await super().get_promotion_state(artifact_id, tenant)
        await self._fire("after_promotion_read")
        return result

    async def put_promotion_state(
        self, state: PromotionState, *, expected_revision: ExpectedRevision = UNSET
    ) -> None:
        self.promotion_writes.append((state, expected_revision))
        await super().put_promotion_state(state, expected_revision=expected_revision)

    async def put_fixation(
        self,
        record: FixationRecord,
        *,
        if_present: bool = False,
        expected_revision: ExpectedRevision = UNSET,
    ) -> None:
        self.fixation_writes.append((record, if_present, expected_revision))
        await super().put_fixation(
            record, if_present=if_present, expected_revision=expected_revision
        )

    async def delete_fixation(
        self,
        intent_hash: str,
        tenant: str | None = None,
        *,
        expected_revision: ExpectedDeleteRevision = UNSET,
    ) -> None:
        self.fixation_deletes.append(expected_revision)
        await super().delete_fixation(intent_hash, tenant, expected_revision=expected_revision)

    async def other_writer_sets_promotion(self, artifact_id: str, **changes: Any) -> None:
        current = await FileStoragePort.get_promotion_state(self, artifact_id)
        assert current is not None
        await FileStoragePort.put_promotion_state(self, dataclasses.replace(current, **changes))

    async def other_writer_sets_fixation(self, record: FixationRecord) -> None:
        await FileStoragePort.put_fixation(self, record)


async def _seed_generated(storage: FileStoragePort, artifact_id: str) -> None:
    await seed(
        storage,
        "component.generated",
        {"artifactId": artifact_id, "request": "r", "html": "<html></html>"},
    )


def _promotions(storage: FileStoragePort, **kwargs: Any) -> Any:
    return create_promotions(
        lineage=create_lineage(storage),
        storage=storage,
        policy=PromotionPolicy(minUses=0, minDistinctSessions=0, judgeBlocking=True),
        **kwargs,
    )


def _types(events: list[LineageEventRecord]) -> list[str]:
    return [e.type for e in events]


class TestPromotionWritesCarryTheRevisionTheyRead:
    def test_stamps_a_fresh_revision_and_chains_expected_revision(self, tmp_path: Path) -> None:
        async def run() -> None:
            storage = _CasStorage(tmp_path)
            await _seed_generated(storage, "a1")
            promotions = _promotions(storage)

            await promotions.act("a1", Nominate(by=ACTOR), ACTOR)
            await promotions.act("a1", JudgeStart(), ACTOR)

            (first, first_expected), (second, second_expected) = storage.promotion_writes
            # No state existed: the first write must be the creator ...
            assert first_expected is None
            assert isinstance(first.revision, str) and first.revision != ""
            # ... and the next one is conditional on exactly what the first one wrote.
            assert second_expected == first.revision
            assert second.revision != first.revision

        asyncio.run(run())

    def test_legacy_record_without_revision_is_written_unconditionally_then_stamped(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            storage = _CasStorage(tmp_path)
            await _seed_generated(storage, "a1")
            await FileStoragePort.put_promotion_state(
                storage, PromotionState(artifactId="a1", status="candidate", updatedAt="x", data={})
            )
            storage.promotion_writes.clear()
            promotions = _promotions(storage)

            await promotions.act("a1", JudgeStart(), ACTOR)

            assert storage.promotion_writes[0][1] is UNSET
            stored = await storage.get_promotion_state("a1")
            assert stored is not None and isinstance(stored.revision, str)

        asyncio.run(run())

    def test_a_port_that_does_not_declare_cas_gets_no_condition_but_still_a_revision(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            storage = _CasStorage(tmp_path, declares_cas=False)
            await _seed_generated(storage, "a1")
            promotions = _promotions(storage)

            await promotions.act("a1", Nominate(by=ACTOR), ACTOR)

            state, expected = storage.promotion_writes[0]
            assert expected is UNSET
            # The revision is still stamped, so enabling a CAS adapter later needs no data migration.
            assert isinstance(state.revision, str)

        asyncio.run(run())

    def test_bulk_nomination_on_a_cas_port_writes_each_candidate_conditionally_not_through_the_batch(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            storage = _CasStorage(tmp_path)
            await _seed_generated(storage, "a1")
            await _seed_generated(storage, "a2")
            batch_calls = 0
            original = storage.put_promotion_states

            async def counting(states: list[PromotionState]) -> None:
                nonlocal batch_calls
                batch_calls += 1
                await original(states)

            storage.put_promotion_states = counting  # type: ignore[method-assign]
            promotions = _promotions(storage)

            await promotions.evaluate_and_list()

            assert batch_calls == 0
            assert [w[1] for w in storage.promotion_writes] == [None, None]
            assert all(isinstance(w[0].revision, str) for w in storage.promotion_writes)

        asyncio.run(run())

    def test_a_concurrent_approve_during_the_nomination_scan_is_not_rolled_back(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            storage = _CasStorage(tmp_path)
            await _seed_generated(storage, "a1")
            await _seed_generated(storage, "a2")
            promotions = _promotions(storage)

            # The scan reads a1 as "no state yet"; right after that read another instance records a decision.
            async def other() -> None:
                await FileStoragePort.put_promotion_state(
                    storage,
                    PromotionState(
                        artifactId="a1",
                        status="approved",
                        updatedAt="2026-01-01T00:00:00.000Z",
                        data={},
                        revision="other-writer",
                    ),
                )

            storage.hooks["after_promotion_read"] = other

            listed = await promotions.evaluate_and_list()

            a1 = await storage.get_promotion_state("a1")
            a2 = await storage.get_promotion_state("a2")
            assert a1 is not None and (a1.status, a1.revision) == ("approved", "other-writer")
            assert a2 is not None and a2.status == "candidate"
            nominated = [
                e.payload["artifactId"]
                for e in await storage.list_lineage()
                if e.type == "component.nominated"
            ]
            assert nominated == ["a2"]
            # The returned list does not claim a transition that was not stored.
            by_id = {c.artifactId: c.status for c in listed}
            assert by_id == {"a1": "in_use", "a2": "candidate"}

        asyncio.run(run())

    def test_bulk_nomination_on_a_port_without_the_declaration_keeps_the_single_batch_write(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            storage = _CasStorage(tmp_path, declares_cas=False)
            await _seed_generated(storage, "a1")
            batch_calls = 0
            original = storage.put_promotion_states

            async def counting(states: list[PromotionState]) -> None:
                nonlocal batch_calls
                batch_calls += 1
                await original(states)

            storage.put_promotion_states = counting  # type: ignore[method-assign]

            await _promotions(storage).evaluate_and_list()

            assert batch_calls == 1
            stored = await storage.get_promotion_state("a1")
            assert stored is not None and isinstance(stored.revision, str)

        asyncio.run(run())


class TestActWithAConcurrentWriter:
    def test_rechecks_the_stored_revision_before_recording_the_audit_event(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            storage = _CasStorage(tmp_path)
            await _seed_generated(storage, "a1")
            promotions = _promotions(storage)
            await promotions.act("a1", Nominate(by=ACTOR), ACTOR)
            before = len(await storage.list_lineage())

            # Another instance moves the artifact on after this act() has loaded it, before its recheck.
            async def other() -> None:
                await storage.other_writer_sets_promotion(
                    "a1", status="withdrawn", revision="other-writer"
                )

            storage.hooks["after_generated_lookup"] = other

            with pytest.raises(StorageConflictError):
                await promotions.act("a1", JudgeStart(), ACTOR)

            assert len(await storage.list_lineage()) == before
            stored = await storage.get_promotion_state("a1")
            assert stored is not None
            assert (stored.status, stored.revision) == ("withdrawn", "other-writer")

        asyncio.run(run())

    def test_a_write_between_the_recheck_and_the_state_write_cannot_overwrite_and_the_orphan_has_no_effect_on_reconcile(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            storage = _CasStorage(tmp_path)
            await _seed_generated(storage, "a1")
            promotions = _promotions(storage)
            await promotions.act("a1", Nominate(by=ACTOR), ACTOR)
            await promotions.act("a1", JudgeStart(), ACTOR)
            await promotions.act("a1", JudgeResult(verdict={"pass": True, "score": 1}), ACTOR)

            # The audit append is the window between the recheck and the CAS write. The other instance
            # publishes the artifact there, so reconcile has a real projection to apply.
            async def other() -> None:
                await storage.other_writer_sets_promotion(
                    "a1",
                    status="published",
                    revision="other-writer",
                    data={
                        "draft": DRAFT.to_wire(),
                        "html": "<html></html>",
                        "sha256": "s",
                        "componentType": DRAFT.componentType,
                    },
                )

            storage.hooks["before_reviewed_append"] = other

            with pytest.raises(StorageConflictError):
                await promotions.act("a1", ReviewApprove(reviewer=ACTOR), ACTOR)

            stored = await storage.get_promotion_state("a1")
            assert stored is not None
            assert (stored.status, stored.revision) == ("published", "other-writer")
            assert "component.reviewed" in _types(await storage.list_lineage())

            # Reconcile's result must be decided by the snapshot alone: run it with the orphan on the log,
            # then with the orphan removed, and require the identical outcome.
            async def run_reconcile() -> tuple[tuple[int, int, int], list[str]]:
                projected: list[str] = []

                async def on_publish(ctx: PublishContext) -> None:
                    projected.append(ctx.artifactId)

                summary = await _promotions(storage, on_publish=on_publish).reconcile()
                return (summary.published, summary.withdrawn, summary.skipped), projected

            with_orphan = await run_reconcile()
            assert with_orphan == ((1, 0, 0), ["a1"])
            storage._lineage[:] = [e for e in storage._lineage if e.type != "component.reviewed"]
            assert await run_reconcile() == with_orphan

        asyncio.run(run())

    def test_publish_conflict_does_not_publish_audit_or_project(self, tmp_path: Path) -> None:
        async def run() -> None:
            storage = _CasStorage(tmp_path)
            await _seed_generated(storage, "a1")
            published: list[str] = []

            async def on_publish(ctx: PublishContext) -> None:
                published.append(ctx.artifactId)

            # The last hook before the snapshot write: the other instance's write lands here.
            async def validate(_ctx: ValidatePublishContext) -> None:
                await storage.other_writer_sets_promotion(
                    "a1", status="withdrawn", revision="other-writer"
                )

            promotions = _promotions(storage, on_publish=on_publish, validate_publish=validate)

            with pytest.raises(StorageConflictError):
                await promotions.approve("a1", DRAFT, ACTOR)

            stored = await storage.get_promotion_state("a1")
            assert stored is not None
            assert (stored.status, stored.revision) == ("withdrawn", "other-writer")
            assert "component.published" not in _types(await storage.list_lineage())
            assert published == []

        asyncio.run(run())


class TestFixationWritesCarryTheRevisionTheyRead:
    def test_replace_vs_refresh_fingerprint_cannot_put_the_old_pinned_spec_back(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            storage = _CasStorage(tmp_path)
            await FileStoragePort.put_fixation(storage, _fixation("old", "r1"))
            fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

            # refresh_fingerprint reads r1; before its write lands another instance replaces the pinnedSpec.
            async def other() -> None:
                await storage.other_writer_sets_fixation(_fixation("new", "r2", "fp-new"))

            storage.hooks["after_fixation_read"] = other

            # Self-healing that loses the race is a no-op, not an error: another instance already moved it on.
            await fixations.refresh_fingerprint(HASH, "fp2")

            stored = await storage.get_fixation(HASH)
            assert stored is not None
            assert stored.revision == "r2"
            assert stored.pinnedSpec.dataVersion == "new"
            _record, if_present, expected = storage.fixation_writes[0]
            assert (if_present, expected) == (True, "r1")

        asyncio.run(run())

    def test_replace_conflict_writes_nothing_and_records_no_intent_migrated(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            storage = _CasStorage(tmp_path)
            await FileStoragePort.put_fixation(storage, _fixation("old", "r1"))
            fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

            async def other() -> None:
                await storage.other_writer_sets_fixation(_fixation("other", "r2"))

            storage.hooks["after_fixation_read"] = other

            with pytest.raises(StorageConflictError):
                await fixations.replace(HASH, _pinned("migrated"), approver=ACTOR)

            stored = await storage.get_fixation(HASH)
            assert stored is not None and stored.revision == "r2"
            assert "intent.migrated" not in _types(await storage.list_lineage())

        asyncio.run(run())

    def test_replace_stamps_a_fresh_revision_conditional_on_the_one_it_read(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            storage = _CasStorage(tmp_path)
            await FileStoragePort.put_fixation(storage, _fixation("old", "r1"))
            fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

            record = await fixations.replace(HASH, _pinned("migrated"), approver=ACTOR)

            assert record is not None and record.revision != "r1"
            _written, if_present, expected = storage.fixation_writes[0]
            assert (if_present, expected) == (True, "r1")

        asyncio.run(run())

    def test_unfixate_conflict_keeps_the_re_approved_fixation_and_records_nothing(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            storage = _CasStorage(tmp_path)
            await FileStoragePort.put_fixation(storage, _fixation("old", "r1"))
            fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

            async def other() -> None:
                await storage.other_writer_sets_fixation(_fixation("re-approved", "r2"))

            storage.hooks["after_fixation_read"] = other

            with pytest.raises(StorageConflictError):
                await fixations.unfixate(HASH, ACTOR)

            stored = await storage.get_fixation(HASH)
            assert stored is not None and stored.revision == "r2"
            assert storage.fixation_deletes == ["r1"]
            assert "intent.unfixated" not in _types(await storage.list_lineage())

        asyncio.run(run())

    def test_invalidate_self_heal_that_loses_the_race_is_a_noop(self, tmp_path: Path) -> None:
        async def run() -> None:
            storage = _CasStorage(tmp_path)
            await FileStoragePort.put_fixation(storage, _fixation("old", "r1", "fp-old"))
            fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

            async def other() -> None:
                await storage.other_writer_sets_fixation(_fixation("re-approved", "r2", "fp-old"))

            storage.hooks["after_fixation_read"] = other

            await fixations.invalidate(HASH, "stale", guard={"ifCatalogFingerprint": "fp-old"})

            stored = await storage.get_fixation(HASH)
            assert stored is not None and stored.revision == "r2"
            assert "intent.unfixated" not in _types(await storage.list_lineage())

        asyncio.run(run())

    def test_invalidate_passes_the_read_revision_to_delete_fixation(self, tmp_path: Path) -> None:
        async def run() -> None:
            storage = _CasStorage(tmp_path)
            await FileStoragePort.put_fixation(storage, _fixation("old", "r1", "fp-old"))
            fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

            await fixations.invalidate(HASH, "stale", guard={"ifCatalogFingerprint": "fp-old"})

            assert storage.fixation_deletes == ["r1"]
            assert await storage.get_fixation(HASH) is None

        asyncio.run(run())

    def test_a_legacy_fixation_without_a_revision_is_rewritten_and_deleted_unconditionally(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            storage = _CasStorage(tmp_path)
            await FileStoragePort.put_fixation(storage, _fixation("old"))
            fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

            await fixations.refresh_fingerprint(HASH, "fp2")
            await fixations.unfixate(HASH, ACTOR)

            assert [(w[1], w[2]) for w in storage.fixation_writes] == [(True, UNSET)]
            assert storage.fixation_deletes == [UNSET]

        asyncio.run(run())

    def test_a_port_that_does_not_declare_cas_keeps_the_pre_cas_call_shapes(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            storage = _CasStorage(tmp_path, declares_cas=False)
            await FileStoragePort.put_fixation(storage, _fixation("old", "r1"))
            fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

            await fixations.refresh_fingerprint(HASH, "fp2")
            await fixations.unfixate(HASH, ACTOR)

            assert [(w[1], w[2]) for w in storage.fixation_writes] == [(True, UNSET)]
            assert storage.fixation_deletes == [UNSET]

        asyncio.run(run())

    def test_fixate_stays_an_unconditional_human_overwrite_with_a_fresh_revision(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            storage = _CasStorage(tmp_path)
            pinned = l1_spec().model_copy(update={"dataVersion": "re-approved"})
            await FileStoragePort.put_fixation(
                storage, dataclasses.replace(_fixation("old", "r1"), intentHash=pinned.intent.hash)
            )
            fixations = create_fixations(lineage=create_lineage(storage), storage=storage)

            record = await fixations.fixate(pinned_spec=pinned, approver=ACTOR)

            assert storage.fixation_writes[0][2] is UNSET
            assert record.revision is not None and record.revision != "r1"

        asyncio.run(run())

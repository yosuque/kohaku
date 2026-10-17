"""Write ordering of Promotions.act() for the generic (non-publish, non-unpublish) action kinds.

The audit event is recorded first and the snapshot (state authority) is persisted second, deliberately. A
throwing record leaves the transition unpersisted, so a retry re-runs the same action (at worst a duplicated
audit event), and a lost `component.reviewed` can never let a retried approve() publish without the
human-approval evidence SPEC LIN-PRM-001 requires.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from kohaku.lineage import (
    ComponentDraft,
    Nominate,
    PromotionPolicy,
    Promotions,
    create_lineage,
    create_promotions,
)
from kohaku.spec import LineageEventRecord, Principal, PromotionState
from kohaku.storage import FileStoragePort

from ._helpers import seed

REVIEWER = Principal(id="admin")
DRAFT = ComponentDraft(
    componentType="sales.customX",
    version="1.0.0",
    intentName="sales.customX",
    description="test draft",
)


class _RecordingStorage(FileStoragePort):
    """Logs `persist` for put_promotion_state and `record:<type>` for append_lineage, in call order.

    `fail_record_once` makes the first append_lineage of that event type raise (and log nothing).
    """

    def __init__(self, data_dir: str | Path, *, fail_record_once: str | None = None) -> None:
        super().__init__(data_dir)
        self.sequence: list[str] = []
        self._fail_record_once = fail_record_once

    async def append_lineage(self, event: LineageEventRecord) -> None:
        if self._fail_record_once is not None and event.type == self._fail_record_once:
            self._fail_record_once = None
            raise RuntimeError("lineage down")
        self.sequence.append(f"record:{event.type}")
        await super().append_lineage(event)

    async def put_promotion_state(self, state: PromotionState) -> None:
        self.sequence.append("persist")
        await super().put_promotion_state(state)


def _promotions(storage: FileStoragePort) -> Promotions:
    return create_promotions(
        lineage=create_lineage(storage),
        storage=storage,
        policy=PromotionPolicy(minUses=1, minDistinctSessions=1, judgeBlocking=False),
    )


def test_act_records_the_audit_event_before_persisting_the_snapshot(tmp_path: Path) -> None:
    async def run() -> None:
        storage = _RecordingStorage(tmp_path)
        # Seeded straight into the file store so it does not appear in the write sequence under test.
        await seed(storage, "component.generated", {"artifactId": "a1", "request": "r"})
        storage.sequence.clear()

        await _promotions(storage).act("a1", Nominate(by=REVIEWER), REVIEWER)

        assert storage.sequence == ["record:component.nominated", "persist"]

    asyncio.run(run())


def test_a_throwing_record_leaves_the_snapshot_unchanged(tmp_path: Path) -> None:
    async def run() -> None:
        storage = _RecordingStorage(tmp_path, fail_record_once="component.nominated")
        await seed(storage, "component.generated", {"artifactId": "a1", "request": "r"})
        storage.sequence.clear()

        with pytest.raises(RuntimeError, match="lineage down"):
            await _promotions(storage).act("a1", Nominate(by=REVIEWER), REVIEWER)

        assert storage.sequence == []
        assert not any(e.type == "component.nominated" for e in await storage.list_lineage())
        assert await storage.get_promotion_state("a1") is None

    asyncio.run(run())


def test_retried_approve_after_a_throwing_reviewed_record_still_reviews_before_publishing(
    tmp_path: Path,
) -> None:
    async def run() -> None:
        storage = _RecordingStorage(tmp_path, fail_record_once="component.reviewed")
        await seed(
            storage,
            "component.generated",
            {"artifactId": "a1", "request": "r", "html": "<html></html>"},
        )
        storage.sequence.clear()
        promotions = _promotions(storage)

        with pytest.raises(RuntimeError, match="lineage down"):
            await promotions.approve("a1", DRAFT, REVIEWER)
        # The failed record must not have advanced the snapshot past the review stage.
        state = await storage.get_promotion_state("a1")
        assert state is not None
        assert state.status == "in_review"

        result = await promotions.approve("a1", DRAFT, REVIEWER)
        assert result.status == "published"

        types = [e.type for e in await storage.list_lineage()]
        assert "component.reviewed" in types
        assert types.index("component.reviewed") < types.index("component.published")

    asyncio.run(run())

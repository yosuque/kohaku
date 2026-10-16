"""Write ordering of Promotions.act() for the generic (non-publish, non-unpublish) action kinds.

The snapshot (state authority) is persisted first and the audit event is recorded second -- the same
state-first, audit-second order as the Publish / Unpublish branches and the fixation service. A failing
persist therefore must not leave an audit event describing a transition that never happened.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from kohaku.lineage import (
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


class _RecordingStorage(FileStoragePort):
    """Logs `persist` for put_promotion_state and `record:<type>` for append_lineage, in call order."""

    def __init__(self, data_dir: str | Path, *, fail_persist: bool = False) -> None:
        super().__init__(data_dir)
        self.sequence: list[str] = []
        self._fail_persist = fail_persist

    async def append_lineage(self, event: LineageEventRecord) -> None:
        self.sequence.append(f"record:{event.type}")
        await super().append_lineage(event)

    async def put_promotion_state(self, state: PromotionState) -> None:
        if self._fail_persist:
            raise RuntimeError("storage down")
        self.sequence.append("persist")
        await super().put_promotion_state(state)


def _promotions(storage: FileStoragePort) -> Promotions:
    return create_promotions(
        lineage=create_lineage(storage),
        storage=storage,
        policy=PromotionPolicy(minUses=1, minDistinctSessions=1, judgeBlocking=False),
    )


def test_act_persists_the_snapshot_before_recording_the_audit_event(tmp_path: Path) -> None:
    async def run() -> None:
        storage = _RecordingStorage(tmp_path)
        # Seeded straight into the file store so it does not appear in the write sequence under test.
        await seed(storage, "component.generated", {"artifactId": "a1", "request": "r"})
        storage.sequence.clear()

        await _promotions(storage).act("a1", Nominate(by=REVIEWER), REVIEWER)

        assert storage.sequence == ["persist", "record:component.nominated"]

    asyncio.run(run())


def test_act_with_a_failing_persist_leaves_no_audit_event(tmp_path: Path) -> None:
    async def run() -> None:
        storage = _RecordingStorage(tmp_path, fail_persist=True)
        await seed(storage, "component.generated", {"artifactId": "a1", "request": "r"})
        storage.sequence.clear()

        with pytest.raises(RuntimeError, match="storage down"):
            await _promotions(storage).act("a1", Nominate(by=REVIEWER), REVIEWER)

        assert storage.sequence == []
        assert not any(e.type == "component.nominated" for e in await storage.list_lineage())
        assert await storage.get_promotion_state("a1") is None

    asyncio.run(run())

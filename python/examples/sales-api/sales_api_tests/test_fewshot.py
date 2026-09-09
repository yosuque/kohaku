"""Test for few-shot supply (port of TS: apps/sample-api/test/fewshot.test.ts).

From the fixation set, deterministically supplies the top 2 by preferring canonical match -> ascending intentHash.
"""

from __future__ import annotations

import asyncio

from kohaku.composer import FewShotExample, FewShotPolicy
from kohaku.spec import (
    FixationRecord,
    IntentInput,
    LineageEventRecord,
    LineageFilter,
    Principal,
    PromotionState,
    UISpec,
    finalize_intent,
)
from sales_api.fewshot import create_fixation_fewshot

INTENT = finalize_intent(IntentInput(canonical="sales.trend", params={}))


def _examples(policy: FewShotPolicy) -> list[FewShotExample]:
    """Helper to run FewShotPolicy.examples (Awaitable) synchronously (asyncio.run requires a Coroutine)."""

    async def go() -> list[FewShotExample]:
        return await policy.examples(INTENT)

    return asyncio.run(go())


def _fixation(canonical: str, intent_hash: str) -> FixationRecord:
    spec = UISpec.model_validate(
        {
            "kohaku": "0.2",
            "intent": {"canonical": canonical, "params": {"tag": canonical}, "hash": intent_hash},
            "dataVersion": "sales@1",
            "components": [
                {"id": "root", "type": "layout.stack", "props": {}, "children": ["h"]},
                {"id": "h", "type": "text.heading", "props": {"level": 2, "text": canonical}},
            ],
            "events": [],
            "provenance": {"tier": "L0", "composedBy": "test", "cache": "fixated"},
        }
    )
    return FixationRecord(
        intentHash=intent_hash,
        canonical=canonical,
        structureHash="sha256:structure",
        pinnedSpec=spec,
        fixatedAt="2026-07-02T00:00:00.000Z",
        approver=Principal(id="tester"),
    )


class _StubStorage:
    """A minimal StoragePort stub where only list_fixations can be swapped in."""

    def __init__(self, fixations: list[FixationRecord]) -> None:
        self._fixations = fixations

    async def get_spec_cache(self, key: str) -> UISpec | None:
        return None

    async def put_spec_cache(
        self, key: str, spec: UISpec, *, ttl_seconds: int | None = None
    ) -> None:
        return None

    async def append_lineage(self, event: LineageEventRecord) -> None:
        return None

    async def list_lineage(
        self, filter: LineageFilter | None = None
    ) -> list[LineageEventRecord]:
        return []

    async def get_promotion_state(
        self, artifact_id: str, tenant: str | None = None
    ) -> PromotionState | None:
        return None

    async def put_promotion_state(self, state: PromotionState) -> None:
        return None

    async def list_promotion_states(self, tenant: str | None = None) -> list[PromotionState]:
        return []

    async def get_fixation(
        self, intent_hash: str, tenant: str | None = None
    ) -> FixationRecord | None:
        return None

    async def put_fixation(self, record: FixationRecord, *, if_present: bool = False) -> None:
        return None

    async def list_fixations(self, tenant: str | None = None) -> list[FixationRecord]:
        return self._fixations

    async def delete_fixation(self, intent_hash: str, tenant: str | None = None) -> None:
        return None


def _h(ch: str) -> str:
    return f"sha256:{ch * 64}"


class TestFixationFewShot:
    def test_empty_returns_empty(self) -> None:
        policy = create_fixation_fewshot(_StubStorage([]))
        assert _examples(policy) == []

    def test_canonical_priority_then_hash_asc(self) -> None:
        policy = create_fixation_fewshot(
            _StubStorage(
                [
                    _fixation("sales.other", _h("1")),  # not a match (smaller hash but deferred)
                    _fixation("sales.trend", _h("c")),
                    _fixation("sales.trend", _h("a")),
                    _fixation("sales.trend", _h("b")),
                ]
            )
        )
        examples = _examples(policy)
        # The 3 matches come first in ascending intentHash order (a < b < c), so the top 2 = a, b.
        assert [e.canonical for e in examples] == ["sales.trend", "sales.trend"]
        assert examples[0].params == {"tag": "sales.trend"}
        assert examples[0].spec.components[0].id == "root"

    def test_no_match_still_supplies_two(self) -> None:
        policy = create_fixation_fewshot(
            _StubStorage(
                [
                    _fixation("sales.a", _h("3")),
                    _fixation("sales.b", _h("1")),
                    _fixation("sales.c", _h("2")),
                ]
            )
        )
        examples = _examples(policy)
        assert [e.canonical for e in examples] == ["sales.b", "sales.c"]

    def test_deterministic(self) -> None:
        storage = _StubStorage(
            [_fixation("sales.trend", _h("b")), _fixation("sales.trend", _h("a"))]
        )
        policy = create_fixation_fewshot(storage)
        first = _examples(policy)
        second = _examples(policy)
        assert [e.canonical for e in first] == ["sales.trend", "sales.trend"]
        assert [(e.canonical, e.params) for e in first] == [
            (e.canonical, e.params) for e in second
        ]

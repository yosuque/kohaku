"""Tests for ComposePolicy.effort (per-tier reasoning effort threaded to the LLM request).

A pytest port of packages/composer/test/effort.test.ts's scenarios.
"""

from __future__ import annotations

import asyncio
from typing import Any

from kohaku.composer import ComposePolicy, EffortPolicy, compose
from kohaku.llm import FakeLlm
from kohaku.storage import FileStoragePort

from .test_compose import _INTENT_INPUT, _L2_HTML, _ctx, _l1_draft


class TestEffort:
    def test_l1_effort_threaded_to_generate_object(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(objects=[_l1_draft()])
            ctx = _ctx(llm, storage, ComposePolicy(effort=EffortPolicy(l1="high")))
            await compose(_INTENT_INPUT, ctx)
            assert len(llm.calls) == 1
            assert llm.calls[0].kind == "object"
            assert llm.calls[0].effort == "high"

        asyncio.run(run())

    def test_l1_unset_effort_sends_none(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(objects=[_l1_draft()])
            ctx = _ctx(llm, storage, ComposePolicy())
            await compose(_INTENT_INPUT, ctx)
            assert llm.calls[0].effort is None

        asyncio.run(run())

    def test_l1_effort_l2_alone_does_not_affect_l1(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(objects=[_l1_draft()])
            ctx = _ctx(llm, storage, ComposePolicy(effort=EffortPolicy(l2="max")))
            await compose(_INTENT_INPUT, ctx)
            assert llm.calls[0].effort is None

        asyncio.run(run())

    def test_l2_effort_threaded_to_generate_text(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(texts=[_L2_HTML])
            ctx = _ctx(
                llm,
                storage,
                ComposePolicy(allowL2=True, routeTier=lambda _i: "L2", effort=EffortPolicy(l2="low")),
            )
            await compose(_INTENT_INPUT, ctx)
            assert len(llm.calls) == 1
            assert llm.calls[0].kind == "text"
            assert llm.calls[0].effort == "low"

        asyncio.run(run())

    def test_l2_effort_l1_alone_does_not_affect_l2(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(texts=[_L2_HTML])
            ctx = _ctx(
                llm,
                storage,
                ComposePolicy(allowL2=True, routeTier=lambda _i: "L2", effort=EffortPolicy(l1="max")),
            )
            await compose(_INTENT_INPUT, ctx)
            assert llm.calls[0].effort is None

        asyncio.run(run())

    def test_l1_and_l2_carry_independent_effort_levels(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage1 = FileStoragePort(tmp_path / "a")
            l1_llm = FakeLlm(objects=[_l1_draft()])
            ctx1 = _ctx(l1_llm, storage1, ComposePolicy(effort=EffortPolicy(l1="low", l2="max")))
            await compose(_INTENT_INPUT, ctx1)
            assert l1_llm.calls[0].effort == "low"

            storage2 = FileStoragePort(tmp_path / "b")
            l2_llm = FakeLlm(texts=[_L2_HTML])
            ctx2 = _ctx(
                l2_llm,
                storage2,
                ComposePolicy(
                    allowL2=True, routeTier=lambda _i: "L2", effort=EffortPolicy(l1="low", l2="max")
                ),
            )
            await compose(_INTENT_INPUT, ctx2)
            assert l2_llm.calls[0].effort == "max"

        asyncio.run(run())

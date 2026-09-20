"""Tests for resolve_intent (port of packages/host-core/test/intent.test.ts, case by case)."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

from kohaku.host_core.intent import (
    IntentSourceGui,
    IntentSourceIntent,
    IntentSourceNl,
    resolve_intent,
)
from kohaku.spec import (
    GuiAction,
    Intent,
    IntentInput,
    NLQuery,
    SemanticInput,
    SessionContext,
    finalize_intent,
)

SESSION = SessionContext(surface="web")


def test_kind_intent_finalizes_the_given_intent_input_directly_without_calling_normalize() -> None:
    calls: list[SemanticInput] = []

    async def normalize(input: SemanticInput, ctx: SessionContext) -> IntentInput:
        calls.append(input)
        return IntentInput(canonical="unused", params={})

    async def run() -> None:
        result = await resolve_intent(
            _FakeSemantic(normalize),
            IntentSourceIntent(intent=IntentInput(canonical="sales.trend", params={"fiscalYear": 2026})),
            SESSION,
        )
        assert calls == []
        assert result.intent.canonical == "sales.trend"
        assert result.intent.params == {"fiscalYear": 2026}
        assert result.intent.hash.startswith("sha256:")
        assert result.current is None

    asyncio.run(run())


def test_kind_nl_normalizes_the_text_via_normalize_then_finalizes_the_result() -> None:
    seen: list[SemanticInput] = []

    async def normalize(input: SemanticInput, ctx: SessionContext) -> IntentInput:
        seen.append(input)
        assert input == NLQuery(kind="nl", text="quarterly sales")
        return IntentInput(canonical="sales.quarterly_summary", params={"quarter": 3})

    async def run() -> None:
        result = await resolve_intent(
            _FakeSemantic(normalize), IntentSourceNl(text="quarterly sales"), SESSION
        )
        assert seen == [NLQuery(kind="nl", text="quarterly sales")]
        assert result.intent.canonical == "sales.quarterly_summary"
        assert result.intent.params == {"quarter": 3}
        assert result.current is None

    asyncio.run(run())


def test_kind_nl_with_locale_forwards_the_locale_to_normalize() -> None:
    seen: list[SemanticInput] = []

    async def normalize(input: SemanticInput, ctx: SessionContext) -> IntentInput:
        seen.append(input)
        assert input == NLQuery(kind="nl", text="quarterly sales", locale="ja")
        return IntentInput(canonical="sales.quarterly_summary", params={"quarter": 3})

    async def run() -> None:
        result = await resolve_intent(
            _FakeSemantic(normalize),
            IntentSourceNl(text="quarterly sales", locale="ja"),
            SESSION,
        )
        assert seen == [NLQuery(kind="nl", text="quarterly sales", locale="ja")]
        assert result.intent.canonical == "sales.quarterly_summary"

    asyncio.run(run())


def test_kind_gui_normalizes_the_delta_against_current_finalizes_and_echoes_back_current() -> None:
    current: Intent = finalize_intent(IntentInput(canonical="sales.trend", params={"region": "us"}))
    seen: list[SemanticInput] = []

    async def normalize(input: SemanticInput, ctx: SessionContext) -> IntentInput:
        seen.append(input)
        assert input == GuiAction(
            kind="gui", action="view.drilldown", params={"region": "japan"}, current=current
        )
        return IntentInput(canonical="sales.trend", params={"region": "japan"})

    async def run() -> None:
        result = await resolve_intent(
            _FakeSemantic(normalize),
            IntentSourceGui(current=current, action="view.drilldown", params={"region": "japan"}),
            SESSION,
        )
        assert seen == [
            GuiAction(kind="gui", action="view.drilldown", params={"region": "japan"}, current=current)
        ]
        assert result.intent.canonical == "sales.trend"
        assert result.intent.params == {"region": "japan"}
        # The gui branch echoes back the pre-event `current` Intent for the caller's own bookkeeping.
        assert result.current is current

    asyncio.run(run())


def test_kind_gui_with_no_current_normalizes_without_one_and_returns_no_current() -> None:
    seen: list[SemanticInput] = []

    async def normalize(input: SemanticInput, ctx: SessionContext) -> IntentInput:
        seen.append(input)
        assert input == GuiAction(kind="gui", action="view.open", params={"region": "japan"})
        return IntentInput(canonical="sales.trend", params={"region": "japan"})

    async def run() -> None:
        result = await resolve_intent(
            _FakeSemantic(normalize),
            IntentSourceGui(action="view.open", params={"region": "japan"}),
            SESSION,
        )
        assert seen == [GuiAction(kind="gui", action="view.open", params={"region": "japan"})]
        assert result.intent.canonical == "sales.trend"
        assert result.current is None

    asyncio.run(run())


class _FakeSemantic:
    """Structurally satisfies host_core.intent's narrow normalize-only protocol."""

    def __init__(
        self, normalize: Callable[[SemanticInput, SessionContext], Awaitable[IntentInput]]
    ) -> None:
        self._normalize = normalize

    async def normalize(self, input: SemanticInput, ctx: SessionContext) -> IntentInput:
        return await self._normalize(input, ctx)

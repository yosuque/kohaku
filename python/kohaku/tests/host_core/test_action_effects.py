"""Tests for apply_action_effects (port of packages/host-core/test/action-effects.test.ts, case by case)."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

from kohaku.host_core.action_effects import apply_action_effects
from kohaku.spec import JsonObject


@dataclass(frozen=True)
class _FakeEffects:
    """Structurally satisfies host_core.action_effects.ActionEffectsResult."""

    invalidates: list[str] | None = None
    refVersions: dict[str, str] | None = None


def test_with_no_action_effects_declared_returns_only_result() -> None:
    calls: list[BaseException] = []

    async def run() -> None:
        response = await apply_action_effects(
            None,
            "sales.updateTarget",
            {},
            {"ok": True},
            calls.append,
            wide_catch=True,
        )
        assert response == {"result": {"ok": True}}
        assert calls == []

    asyncio.run(run())


def test_a_none_result_is_normalized_to_none_and_no_invalidates_ref_versions_keys_are_added_when_absent() -> (
    None
):
    calls: list[BaseException] = []

    async def run() -> None:
        response = await apply_action_effects(
            None,
            "sales.updateTarget",
            {},
            None,
            calls.append,
            wide_catch=True,
        )
        assert response == {"result": None}
        assert "invalidates" not in response
        assert "refVersions" not in response

    asyncio.run(run())


def test_normal_case_invalidates_and_ref_versions_from_action_effects_pass_through() -> None:
    seen_calls: list[tuple[str, JsonObject, object]] = []

    async def action_effects(action: str, payload: JsonObject, result: object) -> _FakeEffects:
        seen_calls.append((action, payload, result))
        return _FakeEffects(
            invalidates=["query://sales/summary?fy=2026"],
            refVersions={"query://sales/summary?fy=2026": "v2"},
        )

    calls: list[BaseException] = []

    async def run() -> None:
        response = await apply_action_effects(
            action_effects,
            "sales.updateTarget",
            {"fiscalYear": 2026},
            {"updated": True},
            calls.append,
            wide_catch=True,
        )
        assert seen_calls == [("sales.updateTarget", {"fiscalYear": 2026}, {"updated": True})]
        assert response == {
            "result": {"updated": True},
            "invalidates": ["query://sales/summary?fy=2026"],
            "refVersions": {"query://sales/summary?fy=2026": "v2"},
        }
        assert calls == []

    asyncio.run(run())


def test_fail_open_when_action_effects_raises_on_effects_error_is_called_and_response_still_succeeds() -> None:
    boom = RuntimeError("effects boom")

    async def action_effects(action: str, payload: JsonObject, result: object) -> _FakeEffects:
        raise boom

    calls: list[BaseException] = []

    async def run() -> None:
        response = await apply_action_effects(
            action_effects,
            "sales.updateTarget",
            {},
            {"updated": True},
            calls.append,
            wide_catch=True,
        )
        assert calls == [boom]
        assert response == {"result": {"updated": True}}

    asyncio.run(run())


def test_wide_catch_true_catches_a_base_exception_subclass_and_reports_it_fail_open() -> None:
    """REST's call site (wide_catch=True) preserves the pre-branch `except BaseException` at
    _routes/binding.py: a BaseException subclass (e.g. asyncio.CancelledError) raised while awaiting the
    action_effects hook is caught, reported via on_effects_error, and the response still succeeds."""
    cancelled = asyncio.CancelledError("effects cancelled")

    async def action_effects(action: str, payload: JsonObject, result: object) -> _FakeEffects:
        raise cancelled

    calls: list[BaseException] = []

    async def run() -> None:
        response = await apply_action_effects(
            action_effects,
            "sales.updateTarget",
            {},
            {"updated": True},
            calls.append,
            wide_catch=True,
        )
        assert calls == [cancelled]
        assert response == {"result": {"updated": True}}

    asyncio.run(run())


def test_wide_catch_false_lets_a_base_exception_subclass_propagate() -> None:
    """MCP's call site (wide_catch=False) preserves the pre-branch `except Exception`: a BaseException
    subclass (e.g. asyncio.CancelledError) raised while awaiting the action_effects hook is NOT caught here
    -- it propagates past this call site, and also past MCP's `_safe_tool` (which itself catches only
    `except Exception`), out to the MCP server's own request/task-cancellation handling, not into a
    structured isError CallToolResult -- matching host_mcp/server.py's pre-branch behaviour."""
    cancelled = asyncio.CancelledError("effects cancelled")

    async def action_effects(action: str, payload: JsonObject, result: object) -> _FakeEffects:
        raise cancelled

    calls: list[BaseException] = []

    async def run() -> None:
        try:
            await apply_action_effects(
                action_effects,
                "sales.updateTarget",
                {},
                {"updated": True},
                calls.append,
                wide_catch=False,
            )
        except asyncio.CancelledError as e:
            assert e is cancelled
        else:
            raise AssertionError("expected CancelledError to propagate")
        assert calls == []

    asyncio.run(run())


def test_wide_catch_false_still_catches_an_ordinary_exception() -> None:
    """wide_catch=False narrows the catch to `Exception`, not to nothing: an ordinary Exception subclass
    (the common case -- a domain hook raising RuntimeError, ValueError, etc.) is still caught and reported
    fail-open, matching host_mcp/server.py's pre-branch `except Exception`."""
    boom = RuntimeError("effects boom")

    async def action_effects(action: str, payload: JsonObject, result: object) -> _FakeEffects:
        raise boom

    calls: list[BaseException] = []

    async def run() -> None:
        response = await apply_action_effects(
            action_effects,
            "sales.updateTarget",
            {},
            {"updated": True},
            calls.append,
            wide_catch=False,
        )
        assert calls == [boom]
        assert response == {"result": {"updated": True}}

    asyncio.run(run())

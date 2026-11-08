"""Cross-language golden for the deterministic pieces of kohaku.semantic_llm (Python side).

Reproduces the `semanticGui` / `semanticPrompts` sections of spec/test/fixtures/cross-language-canonical.json,
which the TS implementation generates (the TS counterpart is spec/test/cross-language.test.ts, with the catalog
in spec/test/semantic-gui-catalog.ts). The catalog below (`test_gui.catalog`) is the hand-built Python twin of
that TS catalog -- keep the two in step.
"""

from __future__ import annotations

from typing import Any

import pytest

from kohaku.semantic_llm import (
    build_normalize_system_prompt,
    build_normalize_user_prompt,
    normalize_gui_action,
)
from kohaku.spec import GuiAction, IntentInput, finalize_intent

from .test_gui import catalog


def test_semantic_gui(cross_language_fixture: dict[str, Any]) -> None:
    """normalize_gui_action must reproduce the TS outputs (and the TS error messages) for the same inputs."""
    cases = cross_language_fixture["semanticGui"]
    assert cases
    for case in cases:
        current = None
        if "current" in case:
            current = finalize_intent(
                IntentInput(
                    canonical=case["current"]["canonical"], params=case["current"]["params"]
                )
            )
        action = GuiAction(
            kind="gui", action=case["action"], params=case["params"], current=current
        )
        if "error" in case:
            with pytest.raises(ValueError) as info:
                normalize_gui_action(action, catalog)
            assert str(info.value) == case["error"], case["name"]
        else:
            out = normalize_gui_action(action, catalog)
            assert {"canonical": out.canonical, "params": out.params} == case["output"], case[
                "name"
            ]


def test_semantic_prompts(cross_language_fixture: dict[str, Any]) -> None:
    """The prompt builders must reproduce the TS bytes (the delimiter block and fence-break defense included)."""
    cases = cross_language_fixture["semanticPrompts"]
    assert cases
    for case in cases:
        assert build_normalize_system_prompt(case["rules"]) == case["system"]
        assert (
            build_normalize_user_prompt(case["catalogDoc"], case["locale"], case["text"])
            == case["user"]
        )

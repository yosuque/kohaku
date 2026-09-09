"""Tests for design-system application (design_system.py + build_l2_prompt + compose wiring).

The TS-side pair is packages/composer/test/design-system.test.ts. EXPECTED_FRAGMENT is pinned as the same
expected string in both languages' tests to guarantee character-level compatibility of the prompt (when
changing it, update both tests at once and bump PROMPT_REVISION).
"""

from __future__ import annotations

import asyncio
from typing import Any

from kohaku.composer import (
    ComposeContext,
    ComposePolicy,
    DesignSystemGuide,
    IntentComposeInput,
    compose,
    design_system_prompt_fragment,
    token_to_css_var,
)
from kohaku.composer.prompt import build_l2_prompt
from kohaku.llm import FakeLlm
from kohaku.registry import core_catalog, resolve_catalog
from kohaku.spec import Intent, IntentInput, compute_intent_hash
from kohaku.storage import FileStoragePort

from .test_compose import _REF, _FakeSemantic

_CATALOG = resolve_catalog(core_catalog())

_GUIDE = DesignSystemGuide(
    tokens={"color.primary": "brand color (override)", "brand.accent": "accent color"},
    guidelines=["Corner radius is 8px", "Spacing in multiples of 4px"],
)

# Same as EXPECTED_FRAGMENT in the TS-side design-system.test.ts (the cross-language contract golden).
_EXPECTED_FRAGMENT = "\n".join(
    [
        "## Design system (must be followed)",
        "- Always specify colors with CSS custom properties (design tokens). Hard-coding #hex, rgb(), hsl(), or color names is forbidden (the host injects the token values, adapting automatically to both light and dark themes)",
        "- Default the background to var(--kohaku-color-background) and the text color to var(--kohaku-color-text)",
        "- Available tokens:",
        "  - var(--kohaku-color-background): page/root background",
        "  - var(--kohaku-color-surface): surface of cards, panels, and table headers",
        "  - var(--kohaku-color-border): borders and separators",
        "  - var(--kohaku-color-text): text color for headings and body",
        "  - var(--kohaku-color-muted): secondary text, captions, axis labels",
        "  - var(--kohaku-color-on-primary): foreground on primary/negative fills (button text etc.)",
        "  - var(--kohaku-color-primary): brand color (override)",
        "  - var(--kohaku-color-positive): emphasis color for increase, rise, success",
        "  - var(--kohaku-color-positive-surface): background surface of success notices",
        "  - var(--kohaku-color-positive-text): text color of success notices",
        "  - var(--kohaku-color-positive-border): border of success notices",
        "  - var(--kohaku-color-negative): emphasis color for decrease, decline, danger",
        "  - var(--kohaku-color-negative-surface): background surface of error notices",
        "  - var(--kohaku-color-negative-text): text color of error notices",
        "  - var(--kohaku-color-negative-border): border of error notices",
        "  - var(--kohaku-color-warning-surface): background surface of warning notices",
        "  - var(--kohaku-color-warning-text): text color of warning notices",
        "  - var(--kohaku-color-info-surface): background surface of info notices",
        "  - var(--kohaku-color-info-text): text color of info notices",
        "  - var(--kohaku-color-info-border): border of info notices",
        "  - var(--kohaku-chart-axis): chart axis lines, ticks, grid lines",
        "  - var(--kohaku-chart-palette-1) … var(--kohaku-chart-palette-7): chart series colors (use from 1 upward)",
        "  - var(--kohaku-brand-accent): accent color",
        "- Additional style rules:",
        "  - Corner radius is 8px",
        "  - Spacing in multiples of 4px",
    ]
)

_TOKEN_HTML = (
    "<!DOCTYPE html><html><head><title>Custom</title>"
    "<style>body{background:var(--kohaku-color-background);color:var(--kohaku-color-text);}"
    "</style></head><body><div id=x></div>"
    "<script>window.kohaku.fetchData('" + _REF + "').then(function(d){"
    "document.getElementById('x').textContent=d.rows.length;window.kohaku.ready();});"
    "</script></body></html>"
)

_RAW_COLOR_HTML = _TOKEN_HTML.replace(
    "background:var(--kohaku-color-background);color:var(--kohaku-color-text);",
    "background:#ffffff;color:rgb(26, 26, 46);",
)

_INTENT_INPUT = IntentComposeInput(intent=IntentInput(canonical="sales.summary", params={"fy": 2026}))


class TestDesignSystemPromptFragment:
    def test_golden_fragment(self) -> None:
        """Default vocabulary + overrides + custom tokens + rules (the cross-language contract golden; same expected value as TS)."""
        assert design_system_prompt_fragment(_GUIDE) == _EXPECTED_FRAGMENT

    def test_empty_guide_lists_default_vocabulary(self) -> None:
        fragment = design_system_prompt_fragment(DesignSystemGuide())
        assert "var(--kohaku-color-primary)" in fragment
        assert "var(--kohaku-chart-palette-1)" in fragment
        assert "Additional style rules" not in fragment

    def test_token_to_css_var(self) -> None:
        assert token_to_css_var("color.positive.surface") == "--kohaku-color-positive-surface"


class TestBuildL2PromptDesignSystem:
    _ARGS: dict[str, Any] = {
        "refs": [_REF],
        "shapes_by_ref": {},
    }

    def _intent(self) -> Intent:
        intent_input = IntentInput(canonical="sales.custom", params={"request": "test"})
        return Intent(
            canonical=intent_input.canonical,
            params=intent_input.params,
            hash=compute_intent_hash(intent_input),
        )

    def test_absent_design_system_keeps_prompt_unchanged(self) -> None:
        prompt = build_l2_prompt(intent=self._intent(), **self._ARGS)
        assert "Design system" not in prompt

    def test_design_system_section_between_shape_and_instruction(self) -> None:
        prompt = build_l2_prompt(intent=self._intent(), design_system=_GUIDE, **self._ARGS)
        ds_at = prompt.index("## Design system")
        assert prompt.index("## Data shape") < ds_at < prompt.index("## Instructions")
        assert _EXPECTED_FRAGMENT in prompt


class TestComposeWithDesignSystem:
    def _policy(self, guide: DesignSystemGuide) -> ComposePolicy:
        return ComposePolicy(allowL2=True, routeTier=lambda _i: "L2", designSystem=guide)

    def _ctx(self, llm: FakeLlm, storage: FileStoragePort, policy: ComposePolicy) -> ComposeContext:
        return ComposeContext(
            catalog=_CATALOG, semantic=_FakeSemantic(), storage=storage, llm=llm, policy=policy
        )

    def test_prompt_contains_design_system_section(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(texts=[_TOKEN_HTML])
            result = await compose(_INTENT_INPUT, self._ctx(llm, storage, self._policy(_GUIDE)))
            assert "## Design system (must be followed)" in llm.calls[0].prompt
            sandbox = next(c for c in result.spec.components if c.type == "sandbox.html")
            assert sandbox.artifact is not None and sandbox.artifact.inline is not None
            assert "var(--kohaku-color-background)" in sandbox.artifact.inline

        asyncio.run(run())

    def test_raw_color_is_repaired(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(texts=[_RAW_COLOR_HTML, _TOKEN_HTML])
            result = await compose(_INTENT_INPUT, self._ctx(llm, storage, self._policy(_GUIDE)))
            assert len(result.trace.attempts) == 2
            assert any("L2_RAW_COLOR" in i for i in result.trace.attempts[0].issues or [])
            assert "L2_RAW_COLOR" in llm.calls[1].prompt
            sandbox = next(c for c in result.spec.components if c.type == "sandbox.html")
            assert sandbox.artifact is not None and sandbox.artifact.inline == _TOKEN_HTML

        asyncio.run(run())

    def test_enforce_off_delivers_raw_color(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(texts=[_RAW_COLOR_HTML])
            guide = DesignSystemGuide(
                tokens=_GUIDE.tokens, guidelines=_GUIDE.guidelines, enforceTokenColors=False
            )
            result = await compose(_INTENT_INPUT, self._ctx(llm, storage, self._policy(guide)))
            assert len(llm.calls) == 1
            # the prompt instruction (section) remains
            assert "## Design system (must be followed)" in llm.calls[0].prompt
            sandbox = next(c for c in result.spec.components if c.type == "sandbox.html")
            assert sandbox.artifact is not None and sandbox.artifact.inline == _RAW_COLOR_HTML

        asyncio.run(run())

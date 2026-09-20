"""Design-kit tests (mirror of packages/composer/test/design-kit.test.ts and design-kit-lint.test.ts).

EXPECTED_KIT_FRAGMENT below is transcribed verbatim from the TS golden of the same name
(packages/composer/test/design-kit.test.ts) — a cross-language byte contract. Change both together and
bump PROMPT_REVISION.
"""

from __future__ import annotations

import asyncio
from typing import Any

from kohaku.composer import (
    DEFAULT_KIT_SKELETON,
    DEFAULT_KIT_VOCABULARY,
    L2_SYSTEM_PROMPT,
    ComposeContext,
    ComposePolicy,
    DesignKitVocabulary,
    DesignSystemGuide,
    IntentComposeInput,
    compose,
    design_kit_prompt_fragment,
)
from kohaku.composer.l2_lint import collect_l2_issues, collect_unknown_kit_classes
from kohaku.composer.prompt import build_l2_prompt
from kohaku.llm import FakeLlm
from kohaku.registry import core_catalog, resolve_catalog
from kohaku.spec import Intent, IntentInput, compute_intent_hash
from kohaku.storage import FileStoragePort

from .test_compose import _REF, _FakeSemantic

_CATALOG = resolve_catalog(core_catalog())

# Transcribed verbatim from TS's EXPECTED_KIT_FRAGMENT (packages/composer/test/design-kit.test.ts) —
# every line below, including the 11-line skeleton tail, is a literal copied from that golden, not
# computed from DEFAULT_KIT_SKELETON/DEFAULT_KIT_VOCABULARY. A golden built from the same constants it is
# meant to check cannot catch a divergence introduced on one language's side only.
_EXPECTED_KIT_FRAGMENT = "\n".join(
    [
        "## Design kit (kohaku v1)",
        "- The host injects a base stylesheet: body already has the font, text color, background and line-height; headings are scaled; :focus-visible rings are provided. Do not restate these",
        "- Prefer the component classes below for common blocks; use the utilities for layout and spacing; write custom CSS only for what they do not cover, and then only with var(--kohaku-*) tokens",
        "- Component classes:",
        "  - k-card: surface container (border, large radius, subtle shadow, padding); put k-card-title first inside it",
        "  - k-card-title: title row of a k-card",
        "  - k-title: section title text",
        "  - k-subtitle: small muted text under a title",
        "  - k-muted: muted (secondary) text color",
        "  - k-num: numeric cell/text — tabular figures, right-aligned",
        "  - k-kpi: a KPI block; children k-kpi-label, k-kpi-value, k-kpi-delta",
        "  - k-kpi-label: small muted label above a KPI value",
        "  - k-kpi-value: the large KPI number",
        "  - k-kpi-delta: change indicator; add is-up or is-down for the color and keep a ▲/▼ symbol in the text",
        "  - k-btn: button base; combine with k-btn-primary, k-btn-secondary or k-btn-danger",
        "  - k-btn-primary: filled brand-color button",
        "  - k-btn-secondary: outline button",
        "  - k-btn-danger: filled danger button",
        "  - k-table: data table (muted header row, row dividers, hover); add k-num to numeric th/td",
        "  - k-badge: small pill; add k-badge-positive / k-badge-negative / k-badge-warning / k-badge-info for tone",
        "  - k-badge-positive: success tone badge",
        "  - k-badge-negative: error/decline tone badge",
        "  - k-badge-warning: warning tone badge",
        "  - k-badge-info: info tone badge",
        "  - k-notice: inline notice box for empty / error / loading states; add k-notice-positive / k-notice-negative / k-notice-warning / k-notice-info for tone",
        "  - k-notice-positive: success notice",
        "  - k-notice-negative: error notice",
        "  - k-notice-warning: warning notice",
        "  - k-notice-info: info notice",
        "  - k-stack: vertical flex column with medium gap",
        "  - k-row: horizontal flex row, centered, wrapping, small gap",
        "  - k-grid: responsive auto-fit grid; add k-grid-2 / k-grid-3 / k-grid-4 for a fixed column count (collapses to one column on narrow widths)",
        "  - k-grid-2: two equal columns",
        "  - k-grid-3: three equal columns",
        "  - k-grid-4: four equal columns",
        "  - k-label: form field label",
        "  - k-input: text input",
        "  - k-select: select control",
        "  - k-chart: put on the <svg> root (width 100%, fixed viewBox); the chart classes below (k-axis … k-line) apply only to elements inside it",
        "  - k-axis: axis line (<line>/<path>)",
        "  - k-gridline: dashed horizontal grid line",
        "  - k-tick: tick label (<text>)",
        "  - k-axis-label: axis title (<text>)",
        "  - k-series-1: series color 1 (fill and stroke); k-series-2 … k-series-7 likewise",
        "  - k-series-2: series color 2",
        "  - k-series-3: series color 3",
        "  - k-series-4: series color 4",
        "  - k-series-5: series color 5",
        "  - k-series-6: series color 6",
        "  - k-series-7: series color 7",
        "  - k-bar: bar rect (rounded corners)",
        "  - k-line: line-chart path (no fill, 2px stroke)",
        "- Utilities (exactly these names exist; any other utility name has no effect): flex, grid, hidden, w-full, flex-col, flex-wrap, items-center, items-start, justify-between, justify-end, grid-cols-2, grid-cols-3, grid-cols-4, gap-1, gap-2, gap-3, gap-4, gap-5, gap-6, p-1, p-2, p-3, p-4, p-5, p-6, px-1, px-2, px-3, px-4, px-5, px-6, py-1, py-2, py-3, py-4, py-5, py-6, m-0, mt-1, mt-2, mt-3, mt-4, mt-5, mt-6, mb-1, mb-2, mb-3, mb-4, mb-5, mb-6, text-xs, text-sm, text-md, text-lg, text-xl, text-2xl, text-muted, text-primary, text-positive, text-negative, text-left, text-center, text-right, truncate, tabular-nums, font-medium, font-semibold, font-bold, rounded-sm, rounded-md, rounded-lg, rounded-full, shadow-sm, shadow-md, border, border-b, bg-surface, bg-background",
        "- Reserved prefixes (kit namespace; never use them for your own class names — pick names like chart-…, panel-…): k-, gap-, p-, px-, py-, pt-, pb-, pl-, pr-, m-, mx-, my-, mt-, mb-, ml-, mr-, text-, font-, rounded-, shadow-, bg-, grid-cols-, items-, justify-, flex-, border-, w-, h-",
        "- Skeleton of a well-formed widget body (adapt it; do not copy verbatim):",
        '  <div class="k-card">',
        '    <div class="k-card-title">Sales by region</div>',
        '    <div class="k-grid k-grid-3 mb-4">',
        '      <div class="k-kpi"><span class="k-kpi-label">Total</span><span class="k-kpi-value">1,234</span><span class="k-kpi-delta is-up">▲ +12%</span></div>',
        "    </div>",
        '    <table class="k-table">',
        '      <thead><tr><th>Region</th><th class="k-num">Sales</th></tr></thead>',
        '      <tbody><tr><td>East</td><td class="k-num">1,234</td></tr></tbody>',
        "    </table>",
        '    <div class="k-notice k-notice-info mt-4 hidden" id="empty">No data for this period</div>',
        "  </div>",
    ]
)


def _widget(body: str, script: str = "") -> str:
    return (
        "<!DOCTYPE html><html><head><title>Custom</title><style>.chart-container{width:100%}</style></head>"
        f"<body>{body}<script>window.kohaku.fetchData('{_REF}').then(function(d){{{script}window.kohaku.ready();}});"
        "</script></body></html>"
    )


_KIT_HTML = _widget(
    '<div class="k-card"><div class="k-card-title">Sales</div><div class="k-grid k-grid-3 gap-4">'
    '<div class="k-kpi"><span class="k-kpi-delta is-up">▲ 3%</span></div></div>'
    '<table class="k-table"><tr><th class="k-num">Sales</th></tr></table><div class="chart-container grid-container"></div></div>',
    'var el=document.createElement("div");el.className="k-notice k-notice-info mt-4";el.classList.add("text-muted","hidden");',
)
_UNKNOWN_HTML = _widget(
    '<div class="k-panel p-4 text-gray-700"><span class="k-kpi-value">1</span></div>',
    'var el=document.createElement("div");el.className="k-tile";el.classList.add("rounded-xl");',
)
_INTENT_INPUT = IntentComposeInput(intent=IntentInput(canonical="sales.summary", params={"fy": 2026}))


class TestVocabularyAndFragment:
    def test_counts(self) -> None:
        """48 classes, 78 utilities, 28 namespaces (the Task 6/7/7b-updated counts; the brief's Step 1
        template predates these and is stale — see the task-10-brief.md addendum)."""
        assert len(DEFAULT_KIT_VOCABULARY.classes) == 48
        assert len(DEFAULT_KIT_VOCABULARY.utilities) == 78
        assert len(DEFAULT_KIT_VOCABULARY.namespaces) == 28

    def test_id_and_version(self) -> None:
        assert DEFAULT_KIT_VOCABULARY.id == "kohaku"
        assert DEFAULT_KIT_VOCABULARY.version == "1"
        assert "k-" in DEFAULT_KIT_VOCABULARY.namespaces
        assert "gap-" in DEFAULT_KIT_VOCABULARY.namespaces
        assert "grid-cols-3" in DEFAULT_KIT_VOCABULARY.utilities
        assert "k-card" in DEFAULT_KIT_VOCABULARY.classes

    def test_skeleton_uses_only_vocabulary_classes_and_is_a_body_fragment(self) -> None:
        import re

        known = set(DEFAULT_KIT_VOCABULARY.classes) | set(DEFAULT_KIT_VOCABULARY.utilities) | {
            "is-up",
            "is-down",
        }
        for m in re.finditer(r'class="([^"]*)"', DEFAULT_KIT_SKELETON):
            for cls in m.group(1).split():
                assert cls in known, cls
        assert "<html" not in DEFAULT_KIT_SKELETON
        assert "<script" not in DEFAULT_KIT_SKELETON

    def test_golden_fragment(self) -> None:
        assert design_kit_prompt_fragment(DEFAULT_KIT_VOCABULARY) == _EXPECTED_KIT_FRAGMENT

    def test_custom_kit_insertion_order_and_skeleton(self) -> None:
        custom = DesignKitVocabulary(
            id="acme",
            version="3",
            classes={"k-tile": "tile"},
            utilities=("flex",),
            namespaces=("k-",),
            skeleton='<div class="k-tile">x</div>',
        )
        fragment = design_kit_prompt_fragment(custom)
        assert fragment.split("\n")[0] == "## Design kit (acme v3)"
        assert "  - k-tile: tile" in fragment
        assert (
            "- Utilities (exactly these names exist; any other utility name has no effect): flex" in fragment
        )
        assert '  <div class="k-tile">x</div>' in fragment
        assert "Sales by region" not in fragment

    def test_system_prompt_ends_with_design_brief(self) -> None:
        assert "Keep the design simple and readable" not in L2_SYSTEM_PROMPT
        assert "- Design brief (follow every point):" in L2_SYSTEM_PROMPT
        assert (
            L2_SYSTEM_PROMPT.split("\n")[-1]
            == "  - never leave browser-default styling on tables, buttons or inputs"
        )

    def test_kit_section_follows_design_system_section(self) -> None:
        intent_input = IntentInput(canonical="sales.custom", params={"request": "test"})
        intent = Intent(
            canonical=intent_input.canonical,
            params=intent_input.params,
            hash=compute_intent_hash(intent_input),
        )
        prompt = build_l2_prompt(
            intent=intent,
            refs=[_REF],
            shapes_by_ref={},
            design_system=DesignSystemGuide(kit=DEFAULT_KIT_VOCABULARY),
        )
        assert prompt.index("## Design system") < prompt.index("## Design kit") < prompt.index(
            "## Output language"
        )
        assert _EXPECTED_KIT_FRAGMENT in prompt
        without = build_l2_prompt(
            intent=intent, refs=[_REF], shapes_by_ref={}, design_system=DesignSystemGuide()
        )
        assert "## Design kit" not in without


class TestUnknownClassLint:
    def test_collect_unknown(self) -> None:
        assert collect_unknown_kit_classes(_UNKNOWN_HTML, DEFAULT_KIT_VOCABULARY) == [
            "k-panel",
            "k-tile",
            "rounded-xl",
            "text-gray-700",
        ]
        assert collect_unknown_kit_classes(_KIT_HTML, DEFAULT_KIT_VOCABULARY) == []

    def test_ignores_interpolated_and_concatenation_prefix_class_names(self) -> None:
        html = _widget(
            '<div class="k-bar k-series-${i}"></div><div class="k-series-"></div>',
            "el.className = `k-${kind}`;",
        )
        assert collect_unknown_kit_classes(html, DEFAULT_KIT_VOCABULARY) == []

    def test_still_flags_an_invented_series_class(self) -> None:
        assert collect_unknown_kit_classes(
            _widget('<div class="k-series-9"></div>'), DEFAULT_KIT_VOCABULARY
        ) == ["k-series-9"]

    def test_scans_set_attribute_class(self) -> None:
        """setAttribute("class", …) — SVG elements cannot use className."""
        html = _widget(
            '<div class="k-card"></div>', 'rect.setAttribute("class", "k-axis k-tickz");'
        )
        assert collect_unknown_kit_classes(html, DEFAULT_KIT_VOCABULARY) == ["k-tickz"]

    def test_flags_the_newly_covered_spacing_prefixes(self) -> None:
        assert collect_unknown_kit_classes(
            _widget('<div class="mx-auto pt-2"></div>'), DEFAULT_KIT_VOCABULARY
        ) == ["mx-auto", "pt-2"]

    def test_issue_only_with_kit(self) -> None:
        assert collect_l2_issues(_UNKNOWN_HTML) == []
        assert collect_l2_issues(_UNKNOWN_HTML, enforce_token_colors=True) == []
        issues = collect_l2_issues(_UNKNOWN_HTML, kit=DEFAULT_KIT_VOCABULARY)
        assert len(issues) == 1 and issues[0].startswith("L2_UNKNOWN_CLASS")
        assert "k-panel, k-tile, rounded-xl, text-gray-700" in issues[0]
        assert collect_l2_issues(_KIT_HTML, kit=DEFAULT_KIT_VOCABULARY) == []


class TestComposeWiring:
    def _ctx(self, llm: FakeLlm, storage: FileStoragePort, guide: DesignSystemGuide) -> ComposeContext:
        policy = ComposePolicy(allowL2=True, routeTier=lambda _i: "L2", designSystem=guide)
        return ComposeContext(catalog=_CATALOG, semantic=_FakeSemantic(), storage=storage, llm=llm, policy=policy)

    def test_unknown_class_is_repaired(self, tmp_path: Any) -> None:
        async def run() -> None:
            llm = FakeLlm(texts=[_UNKNOWN_HTML, _KIT_HTML])
            result = await compose(
                _INTENT_INPUT,
                self._ctx(llm, FileStoragePort(tmp_path), DesignSystemGuide(kit=DEFAULT_KIT_VOCABULARY)),
            )
            assert len(llm.calls) == 2
            assert "## Design kit (kohaku v1)" in llm.calls[0].prompt
            assert any("L2_UNKNOWN_CLASS" in i for i in result.trace.attempts[0].issues or [])
            assert "L2_UNKNOWN_CLASS" in llm.calls[1].prompt
            sandbox = next(c for c in result.spec.components if c.type == "sandbox.html")
            assert sandbox.artifact is not None and sandbox.artifact.inline == _KIT_HTML

        asyncio.run(run())

    def test_enforce_off(self, tmp_path: Any) -> None:
        async def run() -> None:
            llm = FakeLlm(texts=[_UNKNOWN_HTML])
            guide = DesignSystemGuide(kit=DEFAULT_KIT_VOCABULARY, enforceKitClasses=False)
            result = await compose(_INTENT_INPUT, self._ctx(llm, FileStoragePort(tmp_path), guide))
            assert len(llm.calls) == 1
            assert "## Design kit (kohaku v1)" in llm.calls[0].prompt
            sandbox = next(c for c in result.spec.components if c.type == "sandbox.html")
            assert sandbox.artifact is not None and sandbox.artifact.inline == _UNKNOWN_HTML

        asyncio.run(run())

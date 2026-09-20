"""Design-system application for L2 free-form generation (port of TS design-system.ts).

Burning concrete color values into the generated HTML would break the Spec's theme independence
(SPEC-ENV-003) and the cache's cross-theme reuse, so the prompt presents **only token names and usage
descriptions** and makes the output write token references (var(--kohaku-*)). The actual values are injected at
render time by the sandbox (the TS-side renderer-core / sandbox) as `:root` CSS custom properties.

The prompt fragment must be **character-for-character identical** with TS's designSystemPromptFragment (so that
generatorVersion / cache generation separation carries the same meaning across languages).

Also holds the design-kit vocabulary (DesignKitVocabulary / DEFAULT_KIT_VOCABULARY / DEFAULT_KIT_SKELETON /
design_kit_prompt_fragment), the optional wheel that pairs class names + usage descriptions with the built-in
CSS the sandbox injects at render time. Like the token vocabulary above, design_kit_prompt_fragment's output
must be **character-for-character identical** with TS's designKitPromptFragment.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

DEFAULT_TOKEN_DESCRIPTIONS: dict[str, str] = {
    "color.background": "page/root background",
    "color.surface": "surface of cards, panels, and table headers",
    "color.border": "borders and separators",
    "color.text": "text color for headings and body",
    "color.muted": "secondary text, captions, axis labels",
    "color.on-primary": "foreground on primary/negative fills (button text etc.)",
    "color.primary": "brand primary color (emphasis, button fill, selected state)",
    "color.positive": "emphasis color for increase, rise, success",
    "color.positive.surface": "background surface of success notices",
    "color.positive.text": "text color of success notices",
    "color.positive.border": "border of success notices",
    "color.negative": "emphasis color for decrease, decline, danger",
    "color.negative.surface": "background surface of error notices",
    "color.negative.text": "text color of error notices",
    "color.negative.border": "border of error notices",
    "color.warning.surface": "background surface of warning notices",
    "color.warning.text": "text color of warning notices",
    "color.info.surface": "background surface of info notices",
    "color.info.text": "text color of info notices",
    "color.info.border": "border of info notices",
    "chart.axis": "chart axis lines, ticks, grid lines",
    "font.family.sans": "sans-serif font stack for all text",
    "font.family.mono": "monospace font stack (code, raw values)",
    "font.size.xs": "smallest text (captions, axis ticks)",
    "font.size.sm": "small text (labels, helper text)",
    "font.size.md": "body text",
    "font.size.lg": "section titles",
    "font.size.xl": "page titles",
    "font.size.2xl": "large KPI values",
    "space.1": "4px spacing step",
    "space.2": "8px spacing step",
    "space.3": "12px spacing step",
    "space.4": "16px spacing step",
    "space.5": "24px spacing step",
    "space.6": "32px spacing step",
    "radius.sm": "small corner radius (inputs, badges)",
    "radius.md": "medium corner radius (buttons, notices)",
    "radius.lg": "large corner radius (cards, dialogs)",
    "radius.full": "pill radius",
    "shadow.sm": "subtle elevation shadow (cards)",
    "shadow.md": "stronger elevation shadow (dialogs, toasts)",
    "motion.duration": "transition duration",
    "motion.easing": "transition easing",
}
"""Default token vocabulary (usage descriptions of KnownThemeTokens; same as TS's DEFAULT_TOKEN_DESCRIPTIONS).

For prompt presentation only and **carries no values** (the values are owned by renderer-core's default theme
and injected at render time). The ordering is exactly the prompt output order (a contract to string-match TS;
change both languages at once).
"""

_DOT_RE = re.compile(r"\.")


def token_to_css_var(name: str) -> str:
    """Token name → CSS custom property name (same conversion rule as themeTokensToCssVars)."""
    return f"--kohaku-{_DOT_RE.sub('-', name)}"


@dataclass(frozen=True)
class DesignKitVocabulary:
    """The class vocabulary of a design kit as presented to the L2 model (port of TS's DesignKitVocabulary).

    Holds names and usage descriptions only — the CSS lives on the render side (renderer-core's
    defaultDesignKit for the built-in kit).
    """

    id: str
    """Must equal the render-side kit's id (e.g. "kohaku")."""
    version: str
    """Must equal the render-side kit's version."""
    classes: dict[str, str]
    """Component class name → usage description, in prompt order."""
    utilities: tuple[str, ...]
    """Utility class names that exist (exactly these; listed on one prompt line)."""
    namespaces: tuple[str, ...]
    """Prefixes the L2_UNKNOWN_CLASS lint treats as "kit namespace": a class starting with one of these but
    absent from `classes` / `utilities` is sent back for repair. Dash-less utilities (flex, grid, border, …)
    are matched exactly and are not namespaces, so a model's own `grid-container` passes."""
    skeleton: str | None = None
    """Overrides the built-in DEFAULT_KIT_SKELETON in the prompt (a body fragment using the kit classes)."""


DEFAULT_KIT_SKELETON = "\n".join(
    [
        '<div class="k-card">',
        '  <div class="k-card-title">Sales by region</div>',
        '  <div class="k-grid k-grid-3 mb-4">',
        '    <div class="k-kpi"><span class="k-kpi-label">Total</span><span class="k-kpi-value">1,234</span><span class="k-kpi-delta is-up">▲ +12%</span></div>',
        "  </div>",
        '  <table class="k-table">',
        '    <thead><tr><th>Region</th><th class="k-num">Sales</th></tr></thead>',
        '    <tbody><tr><td>East</td><td class="k-num">1,234</td></tr></tbody>',
        "  </table>",
        '  <div class="k-notice k-notice-info mt-4 hidden" id="empty">No data for this period</div>',
        "</div>",
    ]
)
"""A minimal, well-formed widget body using the built-in kit (shown in the prompt, indented by two spaces;
same as TS's DEFAULT_KIT_SKELETON)."""

_SCALE = (1, 2, 3, 4, 5, 6)

_KIT_UTILITIES: tuple[str, ...] = (
    "flex",
    "grid",
    "hidden",
    "w-full",
    "flex-col",
    "flex-wrap",
    "items-center",
    "items-start",
    "justify-between",
    "justify-end",
    "grid-cols-2",
    "grid-cols-3",
    "grid-cols-4",
    *[f"gap-{n}" for n in _SCALE],
    *[f"p-{n}" for n in _SCALE],
    *[f"px-{n}" for n in _SCALE],
    *[f"py-{n}" for n in _SCALE],
    "m-0",
    *[f"mt-{n}" for n in _SCALE],
    *[f"mb-{n}" for n in _SCALE],
    "text-xs",
    "text-sm",
    "text-md",
    "text-lg",
    "text-xl",
    "text-2xl",
    "text-muted",
    "text-primary",
    "text-positive",
    "text-negative",
    "text-left",
    "text-center",
    "text-right",
    "truncate",
    "tabular-nums",
    "font-medium",
    "font-semibold",
    "font-bold",
    "rounded-sm",
    "rounded-md",
    "rounded-lg",
    "rounded-full",
    "shadow-sm",
    "shadow-md",
    "border",
    "border-b",
    "bg-surface",
    "bg-background",
)
"""78 utility class names (same set, in the same order, as TS's KIT_UTILITIES)."""


DEFAULT_KIT_VOCABULARY = DesignKitVocabulary(
    id="kohaku",
    version="1",
    classes={
        "k-card": "surface container (border, large radius, subtle shadow, padding); put k-card-title first inside it",
        "k-card-title": "title row of a k-card",
        "k-title": "section title text",
        "k-subtitle": "small muted text under a title",
        "k-muted": "muted (secondary) text color",
        "k-num": "numeric cell/text — tabular figures, right-aligned",
        "k-kpi": "a KPI block; children k-kpi-label, k-kpi-value, k-kpi-delta",
        "k-kpi-label": "small muted label above a KPI value",
        "k-kpi-value": "the large KPI number",
        "k-kpi-delta": "change indicator; add is-up or is-down for the color and keep a ▲/▼ symbol in the text",
        "k-btn": "button base; combine with k-btn-primary, k-btn-secondary or k-btn-danger",
        "k-btn-primary": "filled brand-color button",
        "k-btn-secondary": "outline button",
        "k-btn-danger": "filled danger button",
        "k-table": "data table (muted header row, row dividers, hover); add k-num to numeric th/td",
        "k-badge": "small pill; add k-badge-positive / k-badge-negative / k-badge-warning / k-badge-info for tone",
        "k-badge-positive": "success tone badge",
        "k-badge-negative": "error/decline tone badge",
        "k-badge-warning": "warning tone badge",
        "k-badge-info": "info tone badge",
        "k-notice": "inline notice box for empty / error / loading states; add k-notice-positive / k-notice-negative / k-notice-warning / k-notice-info for tone",
        "k-notice-positive": "success notice",
        "k-notice-negative": "error notice",
        "k-notice-warning": "warning notice",
        "k-notice-info": "info notice",
        "k-stack": "vertical flex column with medium gap",
        "k-row": "horizontal flex row, centered, wrapping, small gap",
        "k-grid": "responsive auto-fit grid; add k-grid-2 / k-grid-3 / k-grid-4 for a fixed column count (collapses to one column on narrow widths)",
        "k-grid-2": "two equal columns",
        "k-grid-3": "three equal columns",
        "k-grid-4": "four equal columns",
        "k-label": "form field label",
        "k-input": "text input",
        "k-select": "select control",
        "k-chart": "put on the <svg> root (width 100%, fixed viewBox); the chart classes below (k-axis … k-line) apply only to elements inside it",
        "k-axis": "axis line (<line>/<path>)",
        "k-gridline": "dashed horizontal grid line",
        "k-tick": "tick label (<text>)",
        "k-axis-label": "axis title (<text>)",
        "k-series-1": "series color 1 (fill and stroke); k-series-2 … k-series-7 likewise",
        "k-series-2": "series color 2",
        "k-series-3": "series color 3",
        "k-series-4": "series color 4",
        "k-series-5": "series color 5",
        "k-series-6": "series color 6",
        "k-series-7": "series color 7",
        "k-bar": "bar rect (rounded corners)",
        "k-line": "line-chart path (no fill, 2px stroke)",
    },
    utilities=_KIT_UTILITIES,
    namespaces=(
        "k-",
        "gap-",
        "p-",
        "px-",
        "py-",
        "pt-",
        "pb-",
        "pl-",
        "pr-",
        "m-",
        "mx-",
        "my-",
        "mt-",
        "mb-",
        "ml-",
        "mr-",
        "text-",
        "font-",
        "rounded-",
        "shadow-",
        "bg-",
        "grid-cols-",
        "items-",
        "justify-",
        "flex-",
        "border-",
        "w-",
        "h-",
    ),
)
"""The built-in kit vocabulary (pairs with renderer-core's defaultDesignKit; same content, order and
character-for-character description text as TS's DEFAULT_KIT_VOCABULARY — a cross-language string contract)."""


def design_kit_prompt_fragment(kit: DesignKitVocabulary) -> str:
    """The "Design kit" section of the L2 prompt (character-for-character identical with TS's
    designKitPromptFragment). build_l2_prompt_static inserts it right after the design-system section, only
    when design_system.kit is set.
    """
    lines: list[str] = [
        f"## Design kit ({kit.id} v{kit.version})",
        "- The host injects a base stylesheet: body already has the font, text color, background and line-height; headings are scaled; :focus-visible rings are provided. Do not restate these",
        "- Prefer the component classes below for common blocks; use the utilities for layout and spacing; write custom CSS only for what they do not cover, and then only with var(--kohaku-*) tokens",
        "- Component classes:",
    ]
    for name, description in kit.classes.items():
        lines.append(f"  - {name}: {description}")
    lines.append(
        "- Utilities (exactly these names exist; any other utility name has no effect): "
        + ", ".join(kit.utilities)
    )
    lines.append(
        "- Reserved prefixes (kit namespace; never use them for your own class names — pick names like "
        "chart-…, panel-…): " + ", ".join(kit.namespaces)
    )
    lines.append("- Skeleton of a well-formed widget body (adapt it; do not copy verbatim):")
    skeleton = kit.skeleton if kit.skeleton is not None else DEFAULT_KIT_SKELETON
    for line in skeleton.split("\n"):
        lines.append(f"  {line}")
    return "\n".join(lines)


@dataclass(frozen=True)
class DesignSystemGuide:
    """Design system for L2 free-form generation (ComposePolicy.designSystem; paired with TS's DesignSystemGuide)."""

    tokens: dict[str, str] | None = None
    """Token vocabulary (token name → usage description). Merged into the default vocabulary — used both to
    override descriptions and to add custom tokens. **Do not write values here** (the values live in the render-side theme)."""
    guidelines: list[str] | None = None
    """Natural-language style rules (typography, spacing, tone, etc.)."""
    enforceTokenColors: bool = True
    """Whether to lint (L2_RAW_COLOR) hard-coded colors (#hex / rgb() / hsl()) in the output and send them back
    for repair. Default True. Can be set to False as a safety valve when repair does not converge on small models."""
    kit: DesignKitVocabulary | None = None
    """The design kit vocabulary (class names + descriptions, utilities, lint namespaces). When set, the L2
    prompt gains a "Design kit" section (design_kit_prompt_fragment) and the L2_UNKNOWN_CLASS lint rejects
    kit-namespaced class names that are not in the vocabulary. The other wheel is the render side: the kit CSS
    the sandbox injects. Use DEFAULT_KIT_VOCABULARY for the built-in kit. Explicit opt-in: unset keeps the
    prompt bytes of a kit-less design system unchanged."""
    enforceKitClasses: bool = True
    """Whether to lint (L2_UNKNOWN_CLASS) kit-namespaced class names that are not in `kit`. Default True once
    `kit` is set. The same safety valve as enforceTokenColors: set False when repair does not converge on a
    small model (the prompt section remains)."""


def design_system_prompt_fragment(guide: DesignSystemGuide) -> str:
    """The "design system" section of the L2 prompt (character-for-character identical with TS's designSystemPromptFragment).

    Enumerates the default vocabulary + guide.tokens (description overrides / custom-token additions). Custom
    tokens are placed after the default vocabulary in **ascending name order** (a determinism contract to emit
    the same string across languages).
    """
    custom = guide.tokens if guide.tokens is not None else {}
    lines: list[str] = [
        "## Design system (must be followed)",
        "- Always specify colors with CSS custom properties (design tokens). Hard-coding #hex, rgb(), hsl(), or color names is forbidden (the host injects the token values, adapting automatically to both light and dark themes)",
        "- Default the background to var(--kohaku-color-background) and the text color to var(--kohaku-color-text)",
        "- Available tokens:",
    ]
    for name, default_description in DEFAULT_TOKEN_DESCRIPTIONS.items():
        lines.append(f"  - var({token_to_css_var(name)}): {custom.get(name, default_description)}")
    lines.append(
        "  - var(--kohaku-chart-palette-1) … var(--kohaku-chart-palette-7): chart series colors (use from 1 upward)"
    )
    extra_names = sorted(
        name
        for name in custom
        if name not in DEFAULT_TOKEN_DESCRIPTIONS and name != "chart.palette"
    )
    for name in extra_names:
        lines.append(f"  - var({token_to_css_var(name)}): {custom[name]}")
    if guide.guidelines is not None and len(guide.guidelines) > 0:
        lines.append("- Additional style rules:")
        for rule in guide.guidelines:
            lines.append(f"  - {rule}")
    return "\n".join(lines)

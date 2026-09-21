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
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType

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
    classes: Mapping[str, str]
    """Kit class name → usage description. `Mapping`, not `dict` (n-9): `frozen=True` only stops
    reassigning the field itself, not mutating a `dict` value through it, so a plain `dict` field here
    would let `DEFAULT_KIT_VOCABULARY.classes["x"] = "y"` silently corrupt the shared default vocabulary
    every compose call in the process reads. `DEFAULT_KIT_VOCABULARY` below wraps its own literal in
    `MappingProxyType` to close that hole at runtime, not just in the type checker; a caller may still pass
    a plain `dict` (it satisfies `Mapping` structurally). Presented **sorted by name** (not insertion order)
    in the L2 prompt (Task 8/m-15): Python dict iteration keeps insertion order while JS's own key ordering
    treats integer-like keys (e.g. a product kit's "2col") specially (they sort numerically-first, ahead of
    every non-numeric key, regardless of declaration order), so the two languages could otherwise emit
    different design_kit_prompt_fragment bytes for the identical vocabulary content. Sorting output makes
    the fragment a pure function of *content*, not *insertion order* — see design_kit_prompt_fragment's own
    note and policy_fingerprint's `kit` material (context.py), which dropped its `classesOrder` entry for
    the same reason."""
    utilities: tuple[str, ...]
    """Utility class names that exist (exactly these; listed on one prompt line)."""
    namespaces: tuple[str, ...]
    """Prefixes the L2_UNKNOWN_CLASS lint treats as "kit namespace": a class starting with one of these but
    absent from `classes` / `utilities` is sent back for repair. Dash-less utilities (flex, grid, border, …)
    are matched exactly and are not namespaces, so a model's own `grid-container` passes."""
    skeleton: str | None = None
    """A body fragment (using this kit's own classes) shown in the prompt as an example of a well-formed
    widget. **No fallback**: unset means no Skeleton section is shown at all — there is no automatic
    substitution of the built-in kit's skeleton for a kit that happens to share its id/version or was
    derived from it (see design_kit_prompt_fragment's own docstring for why a fallback was rejected). The
    built-in `DEFAULT_KIT_VOCABULARY` below declares its own `skeleton=DEFAULT_KIT_SKELETON`; a product's
    own kit that wants a skeleton in the prompt declares its own the same way."""


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
    "h-full",
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
    *[f"pt-{n}" for n in _SCALE],
    *[f"pb-{n}" for n in _SCALE],
    *[f"pl-{n}" for n in _SCALE],
    *[f"pr-{n}" for n in _SCALE],
    "m-0",
    *[f"m-{n}" for n in _SCALE],
    "mx-auto",
    *[f"mx-{n}" for n in _SCALE],
    *[f"my-{n}" for n in _SCALE],
    *[f"mt-{n}" for n in _SCALE],
    *[f"mb-{n}" for n in _SCALE],
    *[f"ml-{n}" for n in _SCALE],
    *[f"mr-{n}" for n in _SCALE],
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
"""134 utility class names (same set, in the same order, as TS's KIT_UTILITIES)."""


DEFAULT_KIT_VOCABULARY = DesignKitVocabulary(
    id="kohaku",
    version="1",
    classes=MappingProxyType({
        "k-card": "surface container (border, large radius, subtle shadow, padding); put k-card-title first inside it",
        "k-card-title": "title block of a k-card (bold, spaced below)",
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
        "k-input": "text input, full width",
        "k-select": "select control, full width",
        "k-chart": "put on the <svg> root (full width, auto height, block-level; set your own fixed viewBox); the chart classes below (k-axis … k-line) apply only to elements inside it",
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
    }),
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
    # Declared explicitly (not left to a design_kit_prompt_fragment fallback — see that function's own
    # docstring for why a reference-identity fallback was rejected in review). A product's own kit that
    # wants a skeleton in the prompt must declare its own the same way.
    skeleton=DEFAULT_KIT_SKELETON,
)
"""The built-in kit vocabulary (pairs with renderer-core's defaultDesignKit; same content and
character-for-character description text as TS's DEFAULT_KIT_VOCABULARY — a cross-language string
contract). `classes`' declaration order here is otherwise arbitrary (Task 8/m-15):
design_kit_prompt_fragment presents them sorted by name, not in this dict's insertion order."""


def design_kit_prompt_fragment(kit: DesignKitVocabulary) -> str:
    """The "Design kit" section of the L2 prompt (character-for-character identical with TS's
    designKitPromptFragment). build_l2_prompt_static inserts it right after the design-system section, only
    when design_system.kit is set.

    **Empty-input guard (Task 8/m-14):** a section whose backing list is empty is omitted entirely (its
    header line included) rather than emitted with nothing after it — an empty `classes` used to leave a
    dangling "- Component classes:" heading, and empty `utilities`/`namespaces` used to leave a
    self-contradicting "…exist: " / "…names): " line trailing on a colon. This guard fires only for
    genuinely empty input; the built-in `DEFAULT_KIT_VOCABULARY` has all three non-empty, so its own
    fragment is unchanged.

    **No skeleton fallback (Task 8/m-14, revised in review):** the "Skeleton of a well-formed widget body"
    section is shown iff `kit.skeleton` is itself set — there is no fallback to the built-in
    `DEFAULT_KIT_SKELETON` for some other kit that merely "looks like" the built-in one. An earlier version
    of this guard fell back to `DEFAULT_KIT_SKELETON` when `kit is DEFAULT_KIT_VOCABULARY` (reference
    identity), but that breaks silently and toward the "safe" (skeleton-omitted) side whenever the caller's
    `DEFAULT_KIT_VOCABULARY` reference isn't the exact same object this module exported — a `ComposePolicy`
    that round-trips through JSON (a config file, a queue), `dataclasses.replace(DEFAULT_KIT_VOCABULARY,
    ...)`, or (TS) an ESM dual-package hazard all produce a structurally-identical-but-not-identical object,
    silently dropping the skeleton and changing the L2 prompt with no test or observability to catch it.
    `DEFAULT_KIT_VOCABULARY` below instead **declares its own `skeleton=DEFAULT_KIT_SKELETON`**, so the
    built-in kit shows a skeleton for the ordinary reason every other kit does — because it has one — and
    this function never needs to know which kit is "the" built-in one at all. A custom kit that wants a
    skeleton in the prompt declares its own the same way.
    """
    lines: list[str] = [
        f"## Design kit ({kit.id} v{kit.version})",
        "- The host injects a base stylesheet: body already has the font, text color, background and line-height; headings are scaled; :focus-visible rings are provided. Do not restate these",
        "- Prefer the kit classes below for common blocks; use the utilities for layout and spacing; write custom CSS only for what they do not cover, and then only with var(--kohaku-*) tokens",
    ]
    # Sorted by name, not dict.items()' insertion order (m-15): see DesignKitVocabulary.classes' own
    # docstring for why insertion order is not a cross-language-safe contract.
    class_names = sorted(kit.classes)
    if class_names:
        lines.append("- Kit classes:")
        for name in class_names:
            lines.append(f"  - {name}: {kit.classes[name]}")
    if kit.utilities:
        lines.append(
            "- Utilities (exactly these names exist; any other utility name has no effect): "
            + ", ".join(kit.utilities)
        )
    if kit.namespaces:
        lines.append(
            "- Reserved prefixes (kit namespace; never use them for your own class names — pick names like "
            "chart-…, panel-…): " + ", ".join(kit.namespaces)
        )
    if kit.skeleton is not None:
        lines.append("- Skeleton of a well-formed widget body (adapt it; do not copy verbatim):")
        for line in kit.skeleton.split("\n"):
            lines.append(f"  {line}")
    return "\n".join(lines)


@dataclass(frozen=True)
class DesignSystemGuide:
    """Design system for L2 free-form generation (ComposePolicy.designSystem; paired with TS's DesignSystemGuide)."""

    tokens: Mapping[str, str] | None = None
    """Token vocabulary (token name → usage description). Merged into the default vocabulary — used both to
    override descriptions and to add custom tokens. **Do not write values here** (the values live in the
    render-side theme). `Mapping`, not `dict` (n-9) — the same practice as `DesignKitVocabulary.classes`
    above, so the two frozen dataclasses in this module agree on how they type a string-to-string vocabulary
    field; a plain `dict` still satisfies `Mapping` structurally, so existing callers are unaffected."""
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

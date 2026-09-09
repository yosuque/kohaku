"""Design-system application for L2 free-form generation (port of TS design-system.ts).

Burning concrete color values into the generated HTML would break the Spec's theme independence
(SPEC-ENV-003) and the cache's cross-theme reuse, so the prompt presents **only token names and usage
descriptions** and makes the output write token references (var(--kohaku-*)). The actual values are injected at
render time by the sandbox (the TS-side renderer-core / sandbox) as `:root` CSS custom properties.

The prompt fragment must be **character-for-character identical** with TS's designSystemPromptFragment (so that
generatorVersion / cache generation separation carries the same meaning across languages).
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

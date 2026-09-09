import type { KnownThemeTokens } from "@kohaku-ui/spec-core";

/**
 * Design-system application to L2 free generation (ComposePolicy.designSystem).
 *
 * Baking concrete color values into the generated HTML would break the Spec's theme independence
 * (SPEC-ENV-003) and the cache's cross-theme reuse, so the prompt presents **only token names and
 * usage descriptions**, and the output is made to write token references (var(--kohaku-*)). The actual
 * values are injected by the sandbox as `:root` CSS custom properties at render time (renderer-core's
 * sandboxThemeCss). This makes the output follow light/dark switching and brand-theme swaps without regeneration.
 */
export interface DesignSystemGuide {
  /**
   * Token vocabulary (token name → usage description). Merged into the default vocabulary
   * (DEFAULT_TOKEN_DESCRIPTIONS) — used both to override the descriptions of known tokens and to add
   * product-specific tokens. Custom tokens must also supply a value under the same name to the
   * render-side theme (ThemeTokens' open index signature) (without one, var() becomes undefined and
   * falls to a transparent/inherited value).
   * **Do not write values here** (values live in the theme; do not put them in the prompt either).
   */
  tokens?: Record<string, string>;
  /**
   * Natural-language style rules (typography, spacing, tone, etc.). Listed as bullet points in the
   * prompt's design-system section. Free-form text equivalent to Claude Code's design-system skill.
   */
  guidelines?: string[];
  /**
   * Whether to lint (L2_RAW_COLOR) raw color values in the output (#hex / rgb() / hsl()) and send them
   * back for repair. Default true (enforcement is the default once designSystem is set). Can be set to
   * false as a safety valve when repair does not converge on a small model and the fallback rate rises
   * (the prompt instruction remains).
   */
  enforceTokenColors?: boolean;
}

/**
 * Default token vocabulary (usage descriptions for KnownThemeTokens). For prompt presentation only and
 * **holds no values** (the values are owned by renderer-core's default theme and injected at render time).
 * Deprecated aliases (color.danger / color.focus) are not put on the generation vocabulary.
 * Because chart.palette is a CSV-string token, designSystemPromptFragment — not this table — guides it
 * in indexed form (--kohaku-chart-palette-N).
 *
 * The ordering is the prompt output order itself (a contract to string-match the Python implementation; change both languages together).
 */
export const DEFAULT_TOKEN_DESCRIPTIONS: Readonly<Record<string, string>> = {
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
} satisfies Partial<Record<keyof KnownThemeTokens, string>> & Record<string, string>;

/** Token name → CSS custom property name (same conversion rule as renderer-core's themeTokensToCssVars). */
export function tokenToCssVar(name: string): string {
  return `--kohaku-${name.replace(/\./g, "-")}`;
}

/**
 * Builds the "design system" section of the L2 prompt (buildL2Prompt inserts it only when designSystem
 * is specified). Enumerates the default vocabulary + guide.tokens (description overrides, custom-token
 * additions). Custom tokens are listed after the default vocabulary in **ascending name order** (a
 * determinism contract to emit the same string in TS/Python).
 */
export function designSystemPromptFragment(guide: DesignSystemGuide): string {
  const custom = guide.tokens ?? {};
  const lines: string[] = [
    "## Design system (must be followed)",
    "- Always specify colors with CSS custom properties (design tokens). Hard-coding #hex, rgb(), hsl(), or color names is forbidden (the host injects the token values, adapting automatically to both light and dark themes)",
    "- Default the background to var(--kohaku-color-background) and the text color to var(--kohaku-color-text)",
    "- Available tokens:",
  ];
  for (const [name, defaultDescription] of Object.entries(DEFAULT_TOKEN_DESCRIPTIONS)) {
    lines.push(`  - var(${tokenToCssVar(name)}): ${custom[name] ?? defaultDescription}`);
  }
  lines.push(
    "  - var(--kohaku-chart-palette-1) … var(--kohaku-chart-palette-7): chart series colors (use from 1 upward)",
  );
  const extraNames = Object.keys(custom)
    .filter((name) => !(name in DEFAULT_TOKEN_DESCRIPTIONS) && name !== "chart.palette")
    .sort();
  for (const name of extraNames) {
    lines.push(`  - var(${tokenToCssVar(name)}): ${custom[name]}`);
  }
  if (guide.guidelines != null && guide.guidelines.length > 0) {
    lines.push("- Additional style rules:");
    for (const rule of guide.guidelines) {
      lines.push(`  - ${rule}`);
    }
  }
  return lines.join("\n");
}

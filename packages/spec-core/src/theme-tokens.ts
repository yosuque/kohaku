/**
 * The known semantic design tokens. All optional; the defaults are owned by renderer-core's
 * defaultLightTheme / defaultDarkTheme (spec-core holds no values because it is environment-neutral).
 * This is just a "typed vocabulary" = a catalog for completion and type checking; unspecified keys fall
 * back to the default theme set.
 *
 * Status colors are minimized with a surface model of {solid, surface, text, border}.
 * `color.danger` / `color.focus` are deprecated aliases (resolving to color.negative / color.primary
 * respectively; handled by renderer-core's alias table) and have no concrete entry in the default theme
 * — so that spreading them does not break tracking of the target token.
 */
export interface KnownThemeTokens {
  /** Page/root background. Also used for knockout on fills (chart point strokes, etc.). */
  "color.background"?: string;
  /** The surface of cards, table headers, code blocks, loading, and the dialog body. */
  "color.surface"?: string;
  /** Borders and dividers. */
  "color.border"?: string;
  /** Headings and body text. */
  "color.text"?: string;
  /** Secondary text, help, captions, empty states, and axis labels. */
  "color.muted"?: string;
  /** The foreground on primary/negative fills (button text, etc.). */
  "color.on-primary"?: string;
  /** The brand primary color. Button fills, active tabs, focus. */
  "color.primary"?: string;
  /** Focus ring (reserved; aliases to color.primary if unset; v1 has no rendering-side consumer). */
  "color.focus"?: string;
  /** The emphasis solid for increase (rise) and metric deltas. */
  "color.positive"?: string;
  /** The surface of a success notification (toast success background). */
  "color.positive.surface"?: string;
  /** Success text readable on a light background (form success messages, etc.). */
  "color.positive.text"?: string;
  /** The border of a success notification. */
  "color.positive.border"?: string;
  /** The solid for decrease/danger, the danger button, and required marks. */
  "color.negative"?: string;
  /** The surface (background) of an error notification. */
  "color.negative.surface"?: string;
  /** The text of an error notification (readable on the surface). */
  "color.negative.text"?: string;
  /** The border of an error notification. */
  "color.negative.border"?: string;
  /** The surface (background) of a stale/warning notification. */
  "color.warning.surface"?: string;
  /** The text of a stale/warning notification. */
  "color.warning.text"?: string;
  /** The surface of an info notification (toast info background). */
  "color.info.surface"?: string;
  /** The text of an info notification. */
  "color.info.text"?: string;
  /** The border of an info notification. */
  "color.info.border"?: string;
  /** A deprecated alias (= color.negative). Kept for backward compatibility. */
  "color.danger"?: string;
  /**
   * The modal dialog backdrop (overlay.dialog's full-viewport scrim behind the box). Has its own
   * concrete light/dark value (unlike color.danger / color.focus, it is not an alias), but — like
   * color.danger / color.focus / chart.palette — is excluded from the L2 generation vocabulary
   * (composer's BuiltinTokenName): the sandbox never renders a dialog backdrop, so there is nothing
   * for the model to target with it.
   */
  "color.scrim"?: string;
  /** Chart axis lines, reference lines, grid, and ticks. */
  "chart.axis"?: string;
  /** Chart series colors (comma-separated CSV). */
  "chart.palette"?: string;
  // --- Non-color tokens (v2). Values are CSS strings with units; both renderers expand the same string inline. ---
  /** Sans-serif font stack for all UI text. */
  "font.family.sans"?: string;
  /** Monospace font stack (code, raw values). */
  "font.family.mono"?: string;
  /** Font size scale: xs (captions/ticks) → 2xl (KPI values). */
  "font.size.xs"?: string;
  "font.size.sm"?: string;
  "font.size.md"?: string;
  "font.size.lg"?: string;
  "font.size.xl"?: string;
  "font.size.2xl"?: string;
  /** Spacing scale (4px base): 1=4px … 6=32px. */
  "space.1"?: string;
  "space.2"?: string;
  "space.3"?: string;
  "space.4"?: string;
  "space.5"?: string;
  "space.6"?: string;
  /** Corner radii: sm (inputs/badges), md (buttons/notices), lg (cards/dialogs), full (pills). */
  "radius.sm"?: string;
  "radius.md"?: string;
  "radius.lg"?: string;
  "radius.full"?: string;
  /** Elevation shadows: sm (cards), md (dialogs/toasts). Dark themes use stronger values. */
  "shadow.sm"?: string;
  "shadow.md"?: string;
  /** Motion: duration and easing for hover/active transitions. */
  "motion.duration"?: string;
  "motion.easing"?: string;
}

/**
 * The brand. The Spec holds structure only, and tokens are resolved on the Renderer side.
 * Full backward compatibility is preserved with known keys (KnownThemeTokens, with completion) plus an
 * open index signature (also allowing product-specific tokens).
 */
export type ThemeTokens = KnownThemeTokens & Record<string, string | number>;

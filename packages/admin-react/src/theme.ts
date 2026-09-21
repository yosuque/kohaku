import { themeTokensToCssVars } from "@kohaku-ui/renderer-core";
import type { ThemeTokens } from "@kohaku-ui/spec-core";
import type { CSSProperties } from "react";

/**
 * Colour references used by every console style. Each one reads a renderer-core theme variable
 * (`themeTokensToCssVars`: `color.muted` → `--kohaku-color-muted`) with renderer-core's default light value
 * as the fallback, so the console follows the product's ThemeTokens when `adminThemeStyle` is applied to an
 * ancestor and still looks right when nothing is applied at all. No sample-app variables (`--app-*`) here.
 *
 * The `changesRequested*` / `codeBackground` / `codeText` / `disabledSurface` / `negativeBorder` entries are
 * NOT theme tokens `themeTokensToCssVars` emits — they replace hex literals that had no CSS variable at all in
 * the sample's Promotion Review tab (see AGENTS.md's R7 ruling). Each still follows the `--kohaku-color-*`
 * naming convention so a product can override them the same way, with the sample's current hex as the fallback
 * (byte-identical light-mode output today).
 */
export const V = {
  background: "var(--kohaku-color-background, #ffffff)",
  surface: "var(--kohaku-color-surface, #f8fafc)",
  border: "var(--kohaku-color-border, #e5e7eb)",
  text: "var(--kohaku-color-text, #1a1a2e)",
  muted: "var(--kohaku-color-muted, #6b7280)",
  primary: "var(--kohaku-color-primary, #4f46e5)",
  onPrimary: "var(--kohaku-color-on-primary, #ffffff)",
  positive: "var(--kohaku-color-positive, #16a34a)",
  positiveSurface: "var(--kohaku-color-positive-surface, #f0fdf4)",
  positiveText: "var(--kohaku-color-positive-text, #166534)",
  negative: "var(--kohaku-color-negative, #dc2626)",
  negativeSurface: "var(--kohaku-color-negative-surface, #fee2e2)",
  negativeText: "var(--kohaku-color-negative-text, #991b1b)",
  warningSurface: "var(--kohaku-color-warning-surface, #fef9c3)",
  warningText: "var(--kohaku-color-warning-text, #854d0e)",
  infoSurface: "var(--kohaku-color-info-surface, #eff6ff)",
  infoText: "var(--kohaku-color-info-text, #1e40af)",
  infoBorder: "var(--kohaku-color-info-border, #bfdbfe)",
  // --- R7: formerly bare hex literals with no CSS variable at all (packages/admin-react uses in Task 6) -----
  /** Changes-requested banner background (Promotion Review). */
  changesRequestedSurface: "var(--kohaku-color-changes-requested-surface, #fef3c7)",
  /** Changes-requested banner text, and the "request changes" button's own text (same amber tone). */
  changesRequestedText: "var(--kohaku-color-changes-requested-text, #92400e)",
  /** "Request changes" button border. */
  changesRequestedBorder: "var(--kohaku-color-changes-requested-border, #fbbf24)",
  /** Generated-HTML `<pre>` background. */
  codeBackground: "var(--kohaku-color-code-background, #0f172a)",
  /** Generated-HTML `<pre>` text. */
  codeText: "var(--kohaku-color-code-text, #e2e8f0)",
  /** Disabled "approve" button background. */
  disabledSurface: "var(--kohaku-color-disabled-surface, #c7d2fe)",
  /** Withdraw / unpublish button border (their text reuses `negativeText`, same hex as the sample's literal). */
  negativeBorder: "var(--kohaku-color-negative-border, #fca5a5)",
} as const;

/** Inline style for the console root: the theme's tokens as `--kohaku-*` custom properties (empty when no theme). */
export function adminThemeStyle(theme: ThemeTokens | undefined): CSSProperties {
  if (theme == null) return {};
  return themeTokensToCssVars(theme) as CSSProperties;
}

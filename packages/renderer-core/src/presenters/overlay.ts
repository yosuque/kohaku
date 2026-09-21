// framework-free / DOM-free. The source of truth for the inline styles and colors
// of the overlay parts (overlay.dialog / overlay.toast). React spreads them into
// CSSProperties and WC passes the same record to setStyle, achieving a pixel match
// (the same style as visuallyHiddenStyle — the px-appending rule for numbers in
// dom.ts matches dangerousStyleValue).
//
// Colors are resolved via semantic design tokens. Because the theme-taking
// functions go through resolveToken, as long as both renderers pull this shared
// record the resolved values match mechanically (parity guaranteed; follows dark
// mode too).
//
// Deliberate literals (no non-color token fits, so these stay hard-coded; same
// convention as design-kit.ts's own list): `zIndex: 1000` (dialogOverlayStyle,
// toastStyle — layering has no size-scale token), `maxWidth: 480` (dialogBoxStyle,
// toastStyle — a fixed overlay width, not a spacing/sizing value), `borderTop:
// "4px solid …"` (dialogBoxStyle's danger accent band — a one-off accent width, not
// the border-hairline family below), and the `1px solid` hairline border
// (toastStyle — grouped with the other hairline borders across renderer-core, none
// of which map to the radius/space scale).

import type { KnownThemeTokens, ThemeTokens } from "@kohaku-ui/spec-core";
import { resolveToken, type SizingTokens } from "../theme.js";

type StyleRecord = Record<string, string | number>;

/** Dialog background (the modal overlay). Covers the whole viewport with fixed positioning and centers the box. */
export function dialogOverlayStyle(theme: ThemeTokens, sizing: SizingTokens): StyleRecord {
  return {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: sizing.space4,
    background: String(resolveToken(theme, "color.scrim")),
    zIndex: 1000,
  };
}

/** The dialog body box (a surface floating over the scrim = color.surface). danger indicates severity with a top band (accentBorder). */
export function dialogBoxStyle(theme: ThemeTokens, accentBorder: string, sizing: SizingTokens): StyleRecord {
  return {
    display: "flex",
    flexDirection: "column",
    gap: sizing.space3,
    width: "100%",
    maxWidth: 480,
    maxHeight: `calc(100vh - ${sizing.space6})`,
    overflowY: "auto",
    padding: sizing.space5,
    background: String(resolveToken(theme, "color.surface")),
    borderRadius: sizing.radiusLg,
    borderTop: `4px solid ${accentBorder}`,
    boxShadow: sizing.shadowMd,
  };
}

/** Header row (title + close button). */
export function dialogHeaderStyle(sizing: SizingTokens): StyleRecord {
  return {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: sizing.space3,
  };
}

/** Title heading (pass a danger color for danger, the normal color for default). */
export function dialogTitleStyle(color: string, sizing: SizingTokens): StyleRecord {
  return { margin: 0, fontSize: sizing.fontLg, fontWeight: 700, color };
}

/** The close (×) button. */
export function dialogCloseButtonStyle(theme: ThemeTokens, sizing: SizingTokens): StyleRecord {
  return {
    flexShrink: 0,
    background: "none",
    border: "none",
    padding: 0,
    fontSize: sizing.fontXl,
    lineHeight: 1,
    cursor: "pointer",
    color: String(resolveToken(theme, "color.muted")),
  };
}

/** Description text (secondary text lighter than the title = color.muted). */
export function dialogDescriptionStyle(theme: ThemeTokens, sizing: SizingTokens): StyleRecord {
  return {
    margin: 0,
    fontSize: sizing.fontMd,
    color: String(resolveToken(theme, "color.muted")),
  };
}

/** Toast tone → colors (info/success/error). The same {surface, text, border} surface model as DataStateNotice. */
export interface ToastToneColors {
  bg: string;
  fg: string;
  border: string;
}
/**
 * tone → token **names** (unresolved token keys). Structurally isomorphic to
 * ToastToneColors (resolved colors) but with a different meaning, so it is given a
 * separate name to avoid confusion (bg/fg/border hold token names such as
 * "color.info.surface", not color values).
 */
interface ToastToneTokenNames {
  bg: keyof KnownThemeTokens;
  fg: keyof KnownThemeTokens;
  border: keyof KnownThemeTokens;
}
/** tone → token names (surface/text/border). An unknown tone is treated as info. */
const TOAST_TONE_TOKENS: Record<string, ToastToneTokenNames> = {
  info: { bg: "color.info.surface", fg: "color.info.text", border: "color.info.border" },
  success: {
    bg: "color.positive.surface",
    fg: "color.positive.text",
    border: "color.positive.border",
  },
  error: {
    bg: "color.negative.surface",
    fg: "color.negative.text",
    border: "color.negative.border",
  },
};

/** tone → colors (token resolution; an unknown tone is treated as info). */
export function toastToneColors(theme: ThemeTokens, tone: string): ToastToneColors {
  const names = TOAST_TONE_TOKENS[tone] ?? TOAST_TONE_TOKENS["info"]!;
  return {
    bg: String(resolveToken(theme, names.bg)),
    fg: String(resolveToken(theme, names.fg)),
    border: String(resolveToken(theme, names.border)),
  };
}

/** The toast body style (floating at the bottom center). */
export function toastStyle(colors: ToastToneColors, sizing: SizingTokens): StyleRecord {
  return {
    position: "fixed",
    left: "50%",
    bottom: sizing.space5,
    transform: "translateX(-50%)",
    display: "flex",
    alignItems: "center",
    gap: sizing.space3,
    maxWidth: 480,
    padding: `${sizing.space3} ${sizing.space4}`,
    background: colors.bg,
    color: colors.fg,
    border: `1px solid ${colors.border}`,
    borderRadius: sizing.radiusMd,
    fontSize: sizing.fontMd,
    boxShadow: sizing.shadowMd,
    zIndex: 1000,
  };
}

/** The toast dismiss (×) button. */
export function toastDismissButtonStyle(sizing: SizingTokens): StyleRecord {
  return {
    flexShrink: 0,
    background: "none",
    border: "none",
    padding: 0,
    fontSize: sizing.fontLg,
    lineHeight: 1,
    cursor: "pointer",
    color: "inherit",
  };
}

/** The error tone is an interruptive notification (role=alert); everything else is non-interruptive (role=status). */
export function toastRole(tone: string): "alert" | "status" {
  return tone === "error" ? "alert" : "status";
}

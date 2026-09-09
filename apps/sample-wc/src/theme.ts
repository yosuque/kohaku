import { defaultDarkTheme, defaultLightTheme } from "@kohaku-ui/renderer-core";
import type { ThemeTokens } from "@kohaku-ui/spec-core";

export type ThemeMode = "light" | "dark";

/**
 * Brand overrides (same approach as sample-web). Uses kohaku's default themes (light/dark) as the base and layers only the diff on top.
 * The sample uses the default appearance as-is, so the diff is empty. Because the React version (sample-web) and the WC version (this app)
 * inline-expand the same default theme, the two renderers look identical in the same mode (only the chart is merely semantically equivalent).
 */
const brand: ThemeTokens = {};

/**
 * Composes the ThemeTokens for the given mode. It spreads the base and then layers brand on top, so no keys are missing even in dark mode.
 */
export function buildTheme(mode: ThemeMode): ThemeTokens {
  const base = mode === "dark" ? defaultDarkTheme : defaultLightTheme;
  return { ...base, ...brand };
}

import { defaultDarkTheme, defaultLightTheme } from "@kohaku-ui/renderer-core";
import type { ThemeTokens } from "@kohaku-ui/spec-core";

export type ThemeMode = "light" | "dark";

/**
 * This product's brand overrides. Uses kohaku's default themes (light/dark) as the base and layers only the diffs here.
 * The sample uses the default look as-is, so the diff is empty. When customizing in a product, place here only keys that are
 * mode-independent and safe (e.g. `"color.primary"`) — pinning a mode-specific color here would crush the base dark and
 * break dark mode (mind the composition order of base + diff).
 */
const brand: ThemeTokens = {};

/**
 * Composes the ThemeTokens for the given mode. It spreads the base (default light/dark) and then layers the brand diff,
 * so no key is missing even in dark mode (this prevents the accident where a missing key falls back to light and breaks dark).
 * A UI Spec holds only structure, and tokens are resolved on the Renderer side. Both Web and Chat reference the same
 * tokens, so their displays match exactly.
 */
export function buildTheme(mode: ThemeMode): ThemeTokens {
  const base = mode === "dark" ? defaultDarkTheme : defaultLightTheme;
  return { ...base, ...brand };
}

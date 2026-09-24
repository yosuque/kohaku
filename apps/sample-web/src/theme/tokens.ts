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
 * `color.subtle` / `color.track` are not part of `KnownThemeTokens` (renderer-core's default light/dark
 * themes have no such keys), but `@kohaku-ui/admin-react`'s console reads them via
 * `--kohaku-color-subtle` / `--kohaku-color-track` (theme.ts's `V.subtle` / `V.track`, with the package's own
 * light-mode fallback baked in). Before this sample adopted the package, these two values lived only in this
 * app's own `app-theme.css` (`--app-subtle` / `--app-track`, consumed by admin/ui.tsx's BarRow / StatusBadge).
 * Supplying them here per mode is what keeps the console's dark mode matching that CSS's dark values instead
 * of silently falling back to the package's light-mode default (see AGENTS.md's R12 ruling).
 */
const SUBTLE_AND_TRACK: Record<ThemeMode, ThemeTokens> = {
  light: { "color.subtle": "#475569", "color.track": "#f1f5f9" },
  dark: { "color.subtle": "#aab2c0", "color.track": "#262b35" },
};

/**
 * Composes the ThemeTokens for the given mode. It spreads the base (default light/dark) and then layers the brand diff,
 * so no key is missing even in dark mode (this prevents the accident where a missing key falls back to light and breaks dark).
 * A UI Spec holds only structure, and tokens are resolved on the Renderer side. Both Web and Chat reference the same
 * tokens, so their displays match exactly.
 */
export function buildTheme(mode: ThemeMode): ThemeTokens {
  const base = mode === "dark" ? defaultDarkTheme : defaultLightTheme;
  return { ...base, ...SUBTLE_AND_TRACK[mode], ...brand };
}

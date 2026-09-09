import type { ReactNode } from "react";
import { useT } from "../i18n/ui.js";
import { useThemeMode } from "./mode.js";

/**
 * Light/dark toggle (permanently in the App header; same lightweight look as TenantSelector / RoleSelector).
 * The initial value follows prefers-color-scheme; pressing flips it and persists to localStorage (mode.tsx).
 * Both the page chrome (--app-*) and the Spec render theme (buildTheme) follow this mode.
 */
export function ThemeToggle(): ReactNode {
  const { mode, toggle } = useThemeMode();
  const t = useT();
  const isDark = mode === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={t.chrome.themeToggleAria}
      aria-pressed={isDark}
      title={isDark ? t.chrome.themeTitleToLight : t.chrome.themeTitleToDark}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        border: "1px solid var(--app-border, #e5e7eb)",
        borderRadius: 6,
        padding: "4px 10px",
        fontSize: 12,
        background: "var(--app-elevated, #fff)",
        color: "var(--app-text, #1a1a2e)",
        cursor: "pointer",
      }}
    >
      <span aria-hidden="true">{isDark ? "🌙" : "☀️"}</span>
      <span>{isDark ? t.chrome.themeDark : t.chrome.themeLight}</span>
    </button>
  );
}

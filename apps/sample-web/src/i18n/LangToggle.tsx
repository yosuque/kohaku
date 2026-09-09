import type { ReactNode } from "react";
import { useLang } from "./lang.js";
import { useT } from "./ui.js";

/**
 * EN/JA language toggle (permanently in the App header; same lightweight look as ThemeToggle / RoleSelector).
 * The demo defaults to English; switching to JA localizes the whole app — chrome (ui.ts), renderer
 * messages/locale (SpecSurface), facet labels, and the server-side generation language (session.locale).
 * The choice is persisted to localStorage (lang.ts).
 */
export function LangToggle(): ReactNode {
  const { lang, toggle } = useLang();
  const t = useT();
  const isJa = lang === "ja";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={t.chrome.langToggleAria}
      aria-pressed={isJa}
      title={isJa ? t.chrome.langToggleTitleToEn : t.chrome.langToggleTitleToJa}
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
      <span aria-hidden="true">🌐</span>
      <span>
        <strong style={{ color: !isJa ? "var(--app-primary, #4f46e5)" : "inherit" }}>EN</strong>
        {" / "}
        <strong style={{ color: isJa ? "var(--app-primary, #4f46e5)" : "inherit" }}>JA</strong>
      </span>
    </button>
  );
}

import { type ReactNode, useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { LangToggle } from "./i18n/LangToggle.js";
import { useLang } from "./i18n/lang.js";
import { useT } from "./i18n/ui.js";
import { fetchHealth } from "./kohaku/client.js";
import { RoleSelector } from "./kohaku/RoleSelector.js";
import { TenantSelector } from "./kohaku/TenantSelector.js";
import { AdminPage } from "./pages/AdminPage.js";
import { ChatPage } from "./pages/ChatPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { ThemeToggle } from "./theme/ThemeToggle.js";

export function App(): ReactNode {
  const [llmInfo, setLlmInfo] = useState<string | null>(null);
  const { lang } = useLang();
  const t = useT();

  useEffect(() => {
    // In case the API starts up later (e.g. the startup order of pnpm dev), retry at 5-second intervals until it succeeds,
    // then stop on success. On unmount, stop the timer and do not reflect a delayed response.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = (): void => {
      fetchHealth()
        .then((h) => {
          if (!cancelled) setLlmInfo(`${h.llm.provider} / ${h.llm.model}`);
        })
        .catch(() => {
          if (!cancelled) timer = setTimeout(probe, 5000);
        });
    };
    probe();
    return () => {
      cancelled = true;
      if (timer != null) clearTimeout(timer);
    };
  }, []);

  return (
    <div>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 24,
          padding: "0 20px",
          height: 56,
          background: "var(--app-elevated, #fff)",
          borderBottom: "1px solid var(--app-border, #e5e7eb)",
          position: "sticky",
          top: 0,
          zIndex: 10,
        }}
      >
        <div style={{ fontWeight: 800, fontSize: 15, letterSpacing: 0.2 }}>
          kohaku{" "}
          <span style={{ color: "var(--app-muted, #6b7280)", fontWeight: 500 }}>
            {t.chrome.headerSubtitle}
          </span>
        </div>
        <nav style={{ display: "flex", gap: 4 }}>
          {[
            { to: "/", label: t.chrome.navDashboard },
            { to: "/chat", label: t.chrome.navChat },
            { to: "/admin", label: t.chrome.navAdmin },
          ].map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              style={({ isActive }) => ({
                padding: "6px 14px",
                borderRadius: 6,
                textDecoration: "none",
                fontSize: 13.5,
                fontWeight: isActive ? 700 : 450,
                background: isActive ? "var(--app-primary-weak, #eef2ff)" : "transparent",
                color: isActive ? "var(--app-primary, #4f46e5)" : "var(--app-text, #1a1a2e)",
              })}
            >
              {link.label}
            </NavLink>
          ))}
        </nav>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 16 }}>
          <LangToggle />
          <ThemeToggle />
          <RoleSelector />
          <TenantSelector />
          <div
            style={{
              fontSize: 12,
              color: "var(--app-muted, #6b7280)",
              fontFamily: "ui-monospace, monospace",
            }}
          >
            {llmInfo != null ? (
              <>
                LLM: {llmInfo} <span style={{ color: "#10b981" }}>●</span>
              </>
            ) : (
              <>
                {t.chrome.apiNotConnected} <span style={{ color: "#ef4444" }}>●</span>
              </>
            )}
          </div>
        </div>
      </header>
      <Routes>
        {/* key={lang}: a language toggle remounts the dashboard so the surface re-composes in the new
            language (server caches are language-separated, so a repeat toggle is a cache HIT). */}
        <Route path="/" element={<DashboardPage key={lang} />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/admin" element={<AdminPage />} />
      </Routes>
    </div>
  );
}

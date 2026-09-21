import { lazy, type ReactNode, Suspense, useCallback, useState } from "react";
import { t as dict, useT } from "../i18n/ui.js";
import { bumpDataVersion } from "../kohaku/client.js";
import { useTenant } from "../kohaku/tenant.js";
import { AnalyticsTab } from "./admin/AnalyticsTab.js";
import { FixationsTab } from "./admin/FixationsTab.js";
import { LineageTab } from "./admin/LineageTab.js";
import { PromotionsTab } from "./admin/PromotionsTab.js";
import { ErrorBanner, type Notice, type PushNotice } from "./admin/ui.js";

/**
 * The Gallery tab (n-16) is dev/admin-only tooling — its hand-written showcase artifact
 * (gallery-showcase.ts) has no reason to reach production users. It is loaded via React.lazy, and the
 * dynamic import itself sits behind a literal `if (import.meta.env.DEV)` statement rather than only a
 * runtime check inside JSX: Vite replaces `import.meta.env.DEV` with the literal `false` at build time,
 * and Rollup's dead-code elimination then drops the whole `if` branch — including the import() call —
 * before it ever becomes a reachable module, so a production build never emits gallery-showcase.ts's
 * code at all (not even as a separate, unreferenced lazy chunk). Verify with
 * `pnpm --filter @kohaku-ui-sample/web build` and grep the `dist/` output for "gallery-showcase".
 */
let LazyGalleryTab: ReturnType<typeof lazy> | null = null;
if (import.meta.env.DEV) {
  LazyGalleryTab = lazy(() => import("./admin/GalleryTab.js").then((m) => ({ default: m.GalleryTab })));
}

/**
 * The governance surface: View Lineage's audit timeline, L2→L1 promotion review, L1→L0 fixation.
 * The place where "a workflow written nowhere in the code" becomes visible as a sequence of events.
 */
export function AdminPage(): ReactNode {
  const [tab, setTab] = useState<"lineage" | "analytics" | "promotions" | "fixations" | "gallery">("lineage");
  const [notice, setNotice] = useState<Notice | null>(null);
  // Switching tenant remounts the tab and re-fetches (the control plane is isolated by tenant).
  // Switching role does not remount — to demonstrate the 403 by listing candidates as admin, then switching to viewer and pressing
  // the approve button, the candidate list is kept in state (attaching the role header is handled by client.ts).
  const [tenant] = useTenant();
  const t = useT();
  // Push a notification. Default is info (green); 403 / failure is "error" (red). Identity is stable (used for tabs' reload dependency).
  const pushNotice = useCallback<PushNotice>((text, kind = "info") => setNotice({ text, kind }), []);

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18 }}>
        {(
          [
            ["lineage", t.admin.tabLineage],
            ["analytics", t.admin.tabAnalytics],
            ["promotions", t.admin.tabPromotions],
            ["fixations", t.admin.tabFixations],
            // Only listed when the lazy import above is actually wired (dev) — otherwise the button
            // would be a dead end pointing at a tab whose content never renders.
            ...(LazyGalleryTab != null ? ([["gallery", t.admin.tabGallery]] as const) : []),
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            style={{
              border: "1px solid var(--app-border, #e5e7eb)",
              background: tab === key ? "var(--app-primary-weak, #eef2ff)" : "var(--app-elevated, #fff)",
              color: tab === key ? "var(--app-primary, #4f46e5)" : "var(--app-subtle, #475569)",
              fontWeight: tab === key ? 700 : 450,
              borderRadius: 8,
              padding: "8px 16px",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            // dict() (not the hook value) so the notification uses the language at completion time.
            void bumpDataVersion().then((v) => pushNotice(dict().admin.bumpNotice(v)));
          }}
          style={{
            marginLeft: "auto",
            border: "1px solid #fbbf24",
            background: "#fef3c7",
            color: "#92400e",
            borderRadius: 8,
            padding: "8px 14px",
            fontSize: 12.5,
            cursor: "pointer",
          }}
        >
          {t.admin.bumpButton}
        </button>
      </div>
      {notice != null && (
        <ErrorBanner
          text={notice.text}
          kind={notice.kind}
          role={notice.kind === "error" ? "alert" : undefined}
          style={{ padding: "8px 14px", fontSize: 12.5, marginBottom: 12 }}
        />
      )}
      {tab === "lineage" && <LineageTab key={tenant} />}
      {tab === "analytics" && <AnalyticsTab key={tenant} onNotice={pushNotice} />}
      {tab === "promotions" && <PromotionsTab key={tenant} onNotice={pushNotice} />}
      {tab === "fixations" && <FixationsTab key={tenant} onNotice={pushNotice} />}
      {tab === "gallery" && LazyGalleryTab != null && (
        <Suspense fallback={<p>Loading…</p>}>
          <LazyGalleryTab key={tenant} />
        </Suspense>
      )}
    </div>
  );
}

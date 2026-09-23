import type { KohakuClient } from "@kohaku-ui/client";
import type { ThemeTokens } from "@kohaku-ui/spec-core";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { AdminProvider } from "./context.js";
import { type AdminMessages, defaultAdminMessages } from "./messages.js";
import { AnalyticsTab } from "./tabs/AnalyticsTab.js";
import { FixationsTab } from "./tabs/FixationsTab.js";
import { LineageTab } from "./tabs/LineageTab.js";
import type { PromotionDefaults } from "./tabs/promotions/draft.js";
import { PromotionsTab } from "./tabs/promotions/PromotionsTab.js";
import { adminThemeStyle, V } from "./theme.js";
import { ErrorBanner, type NoticeKind, type NotifyFn } from "./ui.js";

export type AdminTabKey = "lineage" | "analytics" | "promotions" | "fixations";

/** A product-specific tab rendered inside the same provider (e.g. the sample's design-kit Gallery). */
export interface AdminExtraTab {
  key: string;
  label: string;
  render: () => ReactNode;
}

export interface KohakuAdminProps {
  client: KohakuClient;
  /**
   * Remount key: the control plane is scoped per tenant, so switching tenant re-fetches every tab. Role is
   * deliberately NOT a remount key (Demo 7 lists candidates as admin, then switches to viewer and presses
   * approve to show the 403 — the list must survive the switch). The header itself rides on `client`: role is
   * not even a prop here — the host attaches it inside its own `client`'s `headers()` hook, and every request
   * this package makes goes back through that same live `client`, so the very next request always carries
   * whatever role is current without any special handling in this component.
   */
  tenant?: string;
  theme?: ThemeTokens;
  messages?: AdminMessages;
  initialTab?: AdminTabKey | string;
  /** Product controls rendered at the right of the tab bar (may call useAdminNotice). */
  toolbar?: ReactNode;
  extraTabs?: AdminExtraTab[];
  promotionDefaults?: PromotionDefaults;
  /** Observes notices in addition to the built-in banner. */
  onNotice?: NotifyFn;
}

interface Notice {
  text: string;
  kind: NoticeKind;
}

export function KohakuAdmin(props: KohakuAdminProps): ReactNode {
  const t = props.messages ?? defaultAdminMessages;
  const [tab, setTab] = useState<string>(props.initialTab ?? "lineage");
  const [notice, setNotice] = useState<Notice | null>(null);

  // A ref (not a useCallback dependency) so `notify`'s identity never changes across renders even though
  // `props.onNotice` may be a fresh closure every time the host re-renders — the same pattern AdminProvider
  // itself uses for the notify it hands to context consumers.
  const onNoticeRef = useRef(props.onNotice);
  onNoticeRef.current = props.onNotice;
  const notify = useCallback<NotifyFn>((text, kind = "info") => {
    setNotice({ text, kind });
    onNoticeRef.current?.(text, kind);
  }, []);

  const tabs: { key: string; label: string; render: () => ReactNode }[] = [
    { key: "lineage", label: t.tabLineage, render: () => <LineageTab /> },
    { key: "analytics", label: t.tabAnalytics, render: () => <AnalyticsTab /> },
    {
      key: "promotions",
      label: t.tabPromotions,
      render: () => (
        <PromotionsTab {...(props.promotionDefaults != null ? { defaults: props.promotionDefaults } : {})} />
      ),
    },
    { key: "fixations", label: t.tabFixations, render: () => <FixationsTab /> },
    ...(props.extraTabs ?? []),
  ];
  const active = tabs.find((x) => x.key === tab) ?? tabs[0]!;

  return (
    <AdminProvider
      client={props.client}
      messages={t}
      onNotice={notify}
      {...(props.theme != null ? { theme: props.theme } : {})}
    >
      <div
        style={{
          maxWidth: 1000,
          margin: "0 auto",
          padding: 24,
          color: V.text,
          ...adminThemeStyle(props.theme),
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18 }}>
          {tabs.map((x) => (
            <button
              key={x.key}
              type="button"
              onClick={() => setTab(x.key)}
              style={{
                border: `1px solid ${V.border}`,
                background: tab === x.key ? V.infoSurface : V.background,
                color: tab === x.key ? V.primary : V.muted,
                fontWeight: tab === x.key ? 700 : 450,
                borderRadius: 8,
                padding: "8px 16px",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              {x.label}
            </button>
          ))}
          {props.toolbar != null && <div style={{ marginLeft: "auto" }}>{props.toolbar}</div>}
        </div>
        {notice != null && (
          <ErrorBanner
            text={notice.text}
            kind={notice.kind}
            role={notice.kind === "error" ? "alert" : undefined}
            style={{ padding: "8px 14px", fontSize: 12.5, marginBottom: 12 }}
          />
        )}
        <div key={`${active.key}:${props.tenant ?? ""}`}>{active.render()}</div>
      </div>
    </AdminProvider>
  );
}

import type { AnalyticsSummaryView } from "@kohaku-ui/client";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { t as dict, useT } from "../../i18n/ui.js";
import { analytics } from "../../kohaku/client.js";
import {
  BarRow,
  card,
  deniedMessage,
  Empty,
  isKohakuHostError,
  type PushNotice,
  StatCard,
  sectionTitle,
  smallButton,
  TIER_COLOR,
} from "./ui.js";

/**
 * Analytics tab: displays the aggregated summary of GET /analytics/summary as a table + inline bars (div width).
 * Does not add a new chart library (matches Admin's existing style). The aggregation window (default 200 events) is stated explicitly on screen, and
 * when storage returns exactly the window limit (window.truncated), it notes that "older events are outside the window".
 */
export function AnalyticsTab({ onNotice }: { onNotice: PushNotice }): ReactNode {
  const [data, setData] = useState<AnalyticsSummaryView | null>(null);
  const t = useT();
  const reload = useCallback(() => {
    void analytics
      .summary()
      .then(setData)
      .catch((e: unknown) => {
        const denied = isKohakuHostError(e) ? deniedMessage(e, dict().admin.analytics.opRead) : null;
        onNotice(denied ?? dict().admin.analytics.fetchFailed, "error");
        setData(null);
      });
  }, [onNotice]);
  useEffect(reload, [reload]);

  if (data == null) {
    return <div style={card}>{t.admin.analytics.loading}</div>;
  }

  const { summary, window } = data;
  const tierTotal = summary.tiers.L0 + summary.tiers.L1 + summary.tiers.L2;
  const cacheEntries: [string, number][] = [
    ["hit", summary.cache.hit],
    ["miss", summary.cache.miss],
    ["bypass", summary.cache.bypass],
    ["fixated", summary.cache.fixated],
    ["other", summary.cache.other],
  ];
  const cacheTotal = cacheEntries.reduce((a, [, n]) => a + n, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 13, color: "var(--app-muted, #6b7280)" }}>
          {t.admin.analytics.description(window.limit, window.truncated, summary.events)}
        </div>
        <button type="button" onClick={reload} style={smallButton}>
          {t.admin.refresh}
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        <StatCard label="view.composed" value={summary.composed} />
        <StatCard
          label={t.admin.analytics.fallbackRateLabel}
          value={`${(summary.fallback.rate * 100).toFixed(1)}%`}
          sub={t.admin.analytics.eventsSub(summary.fallback.total)}
        />
        <StatCard
          label={t.admin.analytics.latencyLabel}
          value={summary.durationMs.p95 != null ? `${summary.durationMs.p95} ms` : "—"}
          sub={`p50 ${summary.durationMs.p50 ?? "—"} / p99 ${summary.durationMs.p99 ?? "—"} ms`}
        />
        <StatCard
          label={t.admin.analytics.fixationsLabel}
          value={summary.fixations.fixated}
          sub={t.admin.analytics.unfixatedSub(summary.fixations.unfixated)}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div style={card}>
          <div style={sectionTitle}>{t.admin.analytics.tierDistribution}</div>
          {(["L0", "L1", "L2"] as const).map((t) => (
            <BarRow key={t} label={t} value={summary.tiers[t]} total={tierTotal} color={TIER_COLOR[t]} />
          ))}
          {tierTotal === 0 && <Empty />}
        </div>
        <div style={card}>
          <div style={sectionTitle}>{t.admin.analytics.cacheBreakdown}</div>
          {cacheEntries.map(([k, n]) => (
            <BarRow key={k} label={k} value={n} total={cacheTotal} color="var(--app-primary, #4f46e5)" />
          ))}
          {cacheTotal === 0 && <Empty />}
        </div>
      </div>

      <div style={card}>
        <div style={sectionTitle}>{t.admin.analytics.fallbackBreakdown}</div>
        <BarRow
          label="generation"
          value={summary.fallback.byKind.generation}
          total={summary.fallback.total}
          color="#c2410c"
        />
        <BarRow
          label="negotiation"
          value={summary.fallback.byKind.negotiation}
          total={summary.fallback.total}
          color="#c2410c"
        />
        <BarRow
          label="unspecified"
          value={summary.fallback.byKind.unspecified}
          total={summary.fallback.total}
          color="var(--app-muted, #9ca3af)"
        />
        {summary.fallback.total === 0 && <Empty text={t.admin.analytics.noFallbacks} />}
      </div>

      <div style={card}>
        <div style={sectionTitle}>{t.admin.analytics.topIntents}</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <tbody>
            {summary.topIntents.map((it) => (
              <tr key={it.intentHash} style={{ borderBottom: "1px solid var(--app-border, #f1f5f9)" }}>
                <td style={{ padding: "5px 8px", fontFamily: "ui-monospace, monospace" }}>{it.canonical}</td>
                <td
                  style={{
                    padding: "5px 8px",
                    color: "var(--app-muted, #6b7280)",
                    fontFamily: "ui-monospace, monospace",
                  }}
                >
                  {it.intentHash.replace("sha256:", "#").slice(0, 10)}
                </td>
                <td style={{ padding: "5px 8px", textAlign: "right", fontWeight: 700 }}>{it.count}</td>
              </tr>
            ))}
            {summary.topIntents.length === 0 && (
              <tr>
                <td style={{ padding: 12, color: "var(--app-muted, #9ca3af)" }}>
                  {t.admin.analytics.noComposeRecords}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={card}>
        <div style={sectionTitle}>{t.admin.analytics.promotionLifecycle}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {(
            [
              ["generated", summary.promotions.generated],
              ["used", summary.promotions.used],
              ["nominated", summary.promotions.nominated],
              ["judge", summary.promotions.judged],
              ["reviewed", summary.promotions.reviewed],
              ["published", summary.promotions.published],
              ["withdrawn", summary.promotions.withdrawn],
            ] as const
          ).map(([label, n]) => (
            <span
              key={label}
              style={{
                background: "var(--app-track, #f1f5f9)",
                color: "var(--app-subtle, #475569)",
                borderRadius: 6,
                padding: "4px 10px",
                fontSize: 12,
              }}
            >
              {label} <strong>{n}</strong>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

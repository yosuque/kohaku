import type { ReactNode } from "react";
import { useAdmin } from "../context.js";
import { useAnalyticsSummary } from "../hooks.js";
import { V } from "../theme.js";
import { TIER_COLOR } from "../tiers.js";
import { BarRow, card, Empty, StatCard, sectionTitle, smallButton } from "../ui.js";

/** "—" for null; seconds under a minute, else minutes with one decimal (review turnaround is human-scale). */
function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

/**
 * GET /analytics/summary as stat cards + inline bars. The aggregation window (default 200 events) is stated
 * on screen; when storage returned exactly the window limit (window.truncated) it says older events are excluded.
 */
export function AnalyticsTab(): ReactNode {
  const { messages: t } = useAdmin();
  const { data, reload } = useAnalyticsSummary();
  if (data == null) return <div style={card}>{t.analytics.loading}</div>;

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
        <div style={{ fontSize: 13, color: V.muted }}>
          {t.analytics.description(window.limit, window.truncated, summary.events)}
        </div>
        <button type="button" onClick={reload} style={smallButton}>
          {t.refresh}
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        <StatCard label="view.composed" value={summary.composed} />
        <StatCard
          label={t.analytics.fallbackRateLabel}
          value={`${(summary.fallback.rate * 100).toFixed(1)}%`}
          sub={t.analytics.eventsSub(summary.fallback.total)}
        />
        <StatCard
          label={t.analytics.latencyLabel}
          value={summary.durationMs.p95 != null ? `${summary.durationMs.p95} ms` : "—"}
          sub={`p50 ${summary.durationMs.p50 ?? "—"} / p99 ${summary.durationMs.p99 ?? "—"} ms`}
        />
        <StatCard
          label={t.analytics.fixationsLabel}
          value={summary.fixations.fixated}
          sub={t.analytics.unfixatedSub(summary.fixations.unfixated)}
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
        <StatCard
          label={t.analytics.reviewTurnaround}
          value={formatDuration(summary.review.durationMs.p50)}
          sub={t.analytics.reviewTurnaroundSub(
            formatDuration(summary.review.durationMs.p95),
            summary.review.count,
          )}
        />
        <StatCard
          label={t.analytics.acceptedAsIs}
          value={summary.review.acceptedAsIs}
          sub={t.analytics.acceptedAsIsSub(summary.promotions.schemaSuggested)}
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div style={card}>
          <div style={sectionTitle}>{t.analytics.tierDistribution}</div>
          {(["L0", "L1", "L2"] as const).map((tier) => (
            <BarRow
              key={tier}
              label={tier}
              value={summary.tiers[tier]}
              total={tierTotal}
              color={TIER_COLOR[tier]!}
            />
          ))}
          {tierTotal === 0 && <Empty text={t.emptyDefault} />}
        </div>
        <div style={card}>
          <div style={sectionTitle}>{t.analytics.cacheBreakdown}</div>
          {cacheEntries.map(([k, n]) => (
            <BarRow key={k} label={k} value={n} total={cacheTotal} color={V.primary} />
          ))}
          {cacheTotal === 0 && <Empty text={t.emptyDefault} />}
        </div>
      </div>
      <div style={card}>
        <div style={sectionTitle}>{t.analytics.fallbackBreakdown}</div>
        <BarRow
          label="generation"
          value={summary.fallback.byKind.generation}
          total={summary.fallback.total}
          color={TIER_COLOR["L2"]!}
        />
        <BarRow
          label="negotiation"
          value={summary.fallback.byKind.negotiation}
          total={summary.fallback.total}
          color={TIER_COLOR["L2"]!}
        />
        <BarRow
          label="unspecified"
          value={summary.fallback.byKind.unspecified}
          total={summary.fallback.total}
          color={V.muted}
        />
        {summary.fallback.total === 0 && <Empty text={t.analytics.noFallbacks} />}
      </div>
      <div style={card}>
        <div style={sectionTitle}>{t.analytics.topIntents}</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <tbody>
            {summary.topIntents.map((it) => (
              <tr key={it.intentHash} style={{ borderBottom: `1px solid ${V.border}` }}>
                <td style={{ padding: "5px 8px", fontFamily: "ui-monospace, monospace" }}>{it.canonical}</td>
                <td
                  style={{
                    padding: "5px 8px",
                    color: V.muted,
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
                <td style={{ padding: 12, color: V.muted }}>{t.analytics.noComposeRecords}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={card}>
        <div style={sectionTitle}>{t.analytics.promotionLifecycle}</div>
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
                background: V.track,
                color: V.subtle,
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

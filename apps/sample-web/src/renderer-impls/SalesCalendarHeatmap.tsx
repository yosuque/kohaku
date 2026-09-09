import { formatNumber } from "@kohaku-ui/renderer-core";
import { type ImplProps, useBoundData, useLocale, useToken } from "@kohaku-ui/renderer-react";
import { DataStateNotice } from "@kohaku-ui/renderer-react/core";
import type { ReactNode } from "react";

/** Short month names for the heatmap column headers (Jan–Dec, index 0-11). */
const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Native implementation of the promoted part sales.calendarHeatmap (pre-bundled).
 * The promotion pipeline's publish registers it as a sandbox-template, but
 * the Web surface already has this implementation registered, so it renders natively
 * (promotion = coming under governance. A sample of how replacing it with a native implementation is a human development task).
 * Data: turns the monthly trend {month, revenue} into a year x month heatmap.
 */
export function SalesCalendarHeatmap({ node }: ImplProps): ReactNode {
  const state = useBoundData(node);
  const locale = useLocale();
  const accent = String(useToken("color.primary", "#4f46e5"));
  const muted = String(useToken("color.muted", "#6b7280"));
  // The pale chip color for empty cells (months with no data) and the knockout text on dark cells. Both follow light/dark via tokens.
  const emptyCell = String(useToken("color.border", "#e5e7eb"));
  const onAccent = String(useToken("color.on-primary", "#ffffff"));

  if (state.status !== "ready") return <DataStateNotice state={state} />;

  const metricCol = state.data.columns.find((c) => c.type === "number");
  const metricKey = metricCol?.key ?? "revenue";
  const metricLabel = metricCol?.label ?? "";
  const monthKey = state.data.columns.find((c) => c.key !== metricKey)?.key ?? "month";
  // Monetary (yen-denominated) detection. Only when metricKey / label indicates revenue/amount do we keep the current
  // ¥ + rounded-to-millions display; when something else (e.g. unit sales) is wired, we use a neutral display without ¥ or "millions"
  // (this prevents a generically-detected column from being formatted as fixed yen and ending up with all-zero cells or a wrong ¥ notation).
  const isCurrency = /revenue|amount|¥/i.test(`${metricKey} ${metricLabel}`);
  // The cell figure stays a plain locale-formatted number of millions (the legend spells out the ¥-millions
  // unit); only the tooltip's full-precision figure needs currency formatting, so it reuses renderer-core's
  // formatNumber (the same primitive presentMetric uses) instead of a second, locale-fixed currency formatter.
  const cellText = (value: number): string =>
    isCurrency ? Math.round(value / 1_000_000).toLocaleString(locale) : value.toLocaleString(locale);
  const tooltipText = (month: string, value: number): string =>
    isCurrency
      ? `${month}: ${formatNumber(value, "currency", "JPY", locale)}`
      : `${month}: ${value.toLocaleString(locale)}`;
  const legend = isCurrency
    ? "Cell values are revenue (¥ millions). Color intensity is the relative monthly value."
    : `Cell values are ${metricLabel || "the metric"}. Color intensity is the relative monthly value.`;

  const cells = state.data.rows
    .map((row) => ({ month: String(row[monthKey] ?? ""), value: Number(row[metricKey] ?? 0) }))
    .filter((c) => /^\d{4}-\d{2}$/.test(c.month))
    .sort((a, b) => a.month.localeCompare(b.month));

  if (cells.length === 0) {
    return <DataStateNotice state={{ status: "error", message: "No monthly data" }} />;
  }

  const max = Math.max(...cells.map((c) => c.value));
  const min = Math.min(...cells.map((c) => c.value));
  const years = [...new Set(cells.map((c) => c.month.slice(0, 4)))].sort();

  const intensity = (value: number): number =>
    max === min ? 0.6 : 0.15 + (0.85 * (value - min)) / (max - min);

  return (
    <div data-kohaku={node.id} style={{ width: "100%", overflowX: "auto" }}>
      {(node.props["title"] as string | undefined) != null && (
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{String(node.props["title"])}</div>
      )}
      <table style={{ borderCollapse: "separate", borderSpacing: 4 }}>
        <thead>
          <tr>
            <th />
            {MONTH_LABELS.map((label) => (
              <th key={label} style={{ fontSize: 10.5, color: muted, fontWeight: 600 }}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {years.map((year) => (
            <tr key={year}>
              <td style={{ fontSize: 11, color: muted, fontWeight: 700, paddingRight: 6 }}>{year}</td>
              {Array.from({ length: 12 }, (_, i) => {
                const month = `${year}-${String(i + 1).padStart(2, "0")}`;
                const cell = cells.find((c) => c.month === month);
                return (
                  <td key={month}>
                    <div
                      title={cell != null ? tooltipText(month, cell.value) : month}
                      style={{
                        width: 34,
                        height: 30,
                        borderRadius: 5,
                        background: cell != null ? accent : emptyCell,
                        opacity: cell != null ? intensity(cell.value) : 1,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 9.5,
                        color: cell != null && intensity(cell.value) > 0.55 ? onAccent : muted,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {cell != null ? cellText(cell.value) : ""}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 10.5, color: muted, marginTop: 4 }}>{legend}</div>
    </div>
  );
}

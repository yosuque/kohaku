import { formatNumber } from "@kohaku-ui/renderer-core";
import { type ImplProps, useBoundData, useLocale, useToken } from "@kohaku-ui/renderer-react";
import { DataStateNotice } from "@kohaku-ui/renderer-react/core";
import type { ReactNode } from "react";

/**
 * React implementation of the CatalogContribution (sales.kpiCard).
 * The data reference is a single row of {label, value, format, note}.
 */
export function KpiCard({ node }: ImplProps): ReactNode {
  const state = useBoundData(node);
  const locale = useLocale();
  const border = String(useToken("color.border", "#e5e7eb"));
  const muted = String(useToken("color.muted", "#6b7280"));
  const accent = String(useToken("color.primary", "#4f46e5"));
  const bg = String(useToken("color.background", "#ffffff"));

  if (state.status !== "ready") return <DataStateNotice state={state} />;
  const row = state.data.rows[0] ?? {};
  const label = (node.props["label"] as string) ?? String(row["label"] ?? "KPI");
  // When value is null/undefined it is a missing measurement (e.g. a denominator of 0. #27). We render it as "—",
  // distinct from 0%, to prevent it being misread as "zero growth / not achieved". The reason goes into note (e.g. "no baseline data").
  const rawValue = row["value"];
  const isMissing = rawValue == null;
  const format = String(row["format"] ?? "number");
  const note = row["note"] != null ? String(row["note"]) : null;

  return (
    <div
      data-kohaku={node.id}
      style={{
        border: `1px solid ${border}`,
        borderRadius: 10,
        background: bg,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ fontSize: 12.5, color: muted, fontWeight: 600 }}>{label}</div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 750,
          color: isMissing ? muted : accent,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {isMissing ? "—" : formatValue(Number(rawValue), format, locale)}
      </div>
      {note != null && <div style={{ fontSize: 11.5, color: muted }}>{note}</div>}
    </div>
  );
}

/**
 * Formats a KPI value for the given renderer locale, reusing renderer-core's `formatNumber` (the same
 * primitive presentMetric uses, avoiding a second currency-formatting definition for a single screen. M2).
 */
function formatValue(value: number, format: string, locale: string): string {
  switch (format) {
    case "currency":
      // Large yen amounts use Intl's compact notation instead of a hardcoded "/1,000,000 + M" abbreviation, so
      // both the digit grouping and the unit word follow the renderer locale (e.g. "¥123M" in en-US vs. a
      // locale-appropriate compact form elsewhere), consistent with formatNumber's currency branch below.
      return value >= 100_000_000
        ? new Intl.NumberFormat(locale, {
            style: "currency",
            currency: "JPY",
            notation: "compact",
            maximumFractionDigits: 1,
          }).format(value)
        : formatNumber(value, "currency", "JPY", locale);
    case "percent":
      return `${value.toLocaleString(locale, { maximumFractionDigits: 1 })}%`;
    default:
      return formatNumber(value, "number", "JPY", locale);
  }
}

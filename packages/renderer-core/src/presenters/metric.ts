import type { ComponentNode, JsonObject, JsonValue } from "@kohaku-ui/spec-core";
import type { RendererMessages } from "../messages.js";

export type MetricFormat = "number" | "currency" | "percent";

/** The result of computeDelta (direction, symbol, and signed formatting). */
export interface MetricDelta {
  direction: "up" | "down" | "flat";
  arrow: string;
  signed: string;
}

/** Formats a value (the body formatting for number/currency/percent) + appends an optional unit. Non-numbers pass through. */
export function formatValue(
  value: JsonValue | undefined,
  format: MetricFormat,
  currency: string,
  unit: string | undefined,
  locale: string,
): string {
  if (typeof value !== "number") return value == null ? "—" : String(value);
  const base = formatNumber(value, format, currency, locale);
  return unit != null && unit !== "" ? `${base}${unit}` : base;
}

/**
 * Formats the numeric body per format (adding the sign / unit is the caller's
 * job). currency uses Intl.NumberFormat's currency style, percent appends % at the
 * end, and number uses digit grouping.
 */
export function formatNumber(value: number, format: MetricFormat, currency: string, locale: string): string {
  if (format === "currency") {
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency }).format(value);
    } catch {
      // An invalid currency code (non ISO 4217) makes currency formatting throw, so we fall back to digit grouping.
      return value.toLocaleString(locale);
    }
  }
  if (format === "percent") return `${value.toLocaleString(locale)}%`;
  return value.toLocaleString(locale);
}

/** The resolved token colors the metric view depends on (each renderer resolves its own theme). */
export interface MetricViewTokens {
  muted: string;
  positive: string;
  negative: string;
}

/** The framework-free view model of presentMetric. Both renderers emit markup from this same shape (parity by construction). */
export interface MetricView {
  label: string;
  valueText: string;
  delta: MetricDelta | null;
  /** Decided by "whether it is the good direction" (accounting for positiveIsGood inversion); direction is also conveyed via symbol and text, not color alone (a11y). */
  deltaColor: string;
  deltaAria: string | null;
  /** The whole view read out as a single label (value followed by the period-over-period change). */
  ariaLabel: string;
}

/**
 * Derives presentMetric's view model from the node's props + the first data row.
 * The single home of the prop defaults (format=number / currency=JPY / positiveIsGood=true) and the
 * delta-color decision, avoiding duplicating it across renderer-react / renderer-wc.
 */
export function resolveMetricView(
  node: ComponentNode,
  row: JsonObject | undefined,
  tokens: MetricViewTokens,
  messages: RendererMessages,
  locale: string,
): MetricView {
  const label = String(node.props["label"] ?? "");
  const valueColumn = String(node.props["valueColumn"] ?? "");
  const deltaColumn = node.props["deltaColumn"] as string | undefined;
  const format = ((node.props["format"] as string) ?? "number") as MetricFormat;
  const unit = node.props["unit"] as string | undefined;
  // The currency code (ISO 4217) when format="currency". Defaults to "JPY" if unspecified.
  const currency = (node.props["currency"] as string | undefined) ?? "JPY";
  const positiveIsGood = node.props["positiveIsGood"] !== false;

  const rawValue = row?.[valueColumn];
  const valueText = formatValue(rawValue, format, currency, unit, locale);

  const rawDelta = deltaColumn != null ? row?.[deltaColumn] : undefined;
  const delta = deltaColumn != null ? computeDelta(rawDelta, format, currency, unit, locale) : null;

  const deltaColor =
    delta == null || delta.direction === "flat"
      ? tokens.muted
      : (delta.direction === "up") === positiveIsGood
        ? tokens.positive
        : tokens.negative;

  const deltaAria = delta != null ? messages.metricDelta(delta.signed, delta.direction) : null;
  return {
    label,
    valueText,
    delta,
    deltaColor,
    deltaAria,
    ariaLabel: messages.metricAriaLabel(label, valueText, deltaAria),
  };
}

/** Computes the direction, symbol, and signed formatting of a change all at once. */
export function computeDelta(
  value: JsonValue | undefined,
  format: MetricFormat,
  currency: string,
  unit: string | undefined,
  locale: string,
): MetricDelta | null {
  if (typeof value !== "number") return null;
  const direction = value > 0 ? "up" : value < 0 ? "down" : "flat";
  const arrow = direction === "up" ? "▲" : direction === "down" ? "▼" : "—";
  const sign = value > 0 ? "+" : ""; // negative values already carry a "-" from the formatting result
  const magnitude = formatNumber(value, format, currency, locale);
  const signed = `${sign}${magnitude}${unit != null && unit !== "" ? unit : ""}`;
  return { direction, arrow, signed };
}

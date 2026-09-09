import type { ComponentNode, JsonObject, UISpec } from "@kohaku-ui/spec-core";
import { hasDeclaredEvent } from "../control/emit.js";
import type { RendererMessages } from "../messages.js";

/** Default palette for series colors (shared by renderer-react's Recharts and renderer-wc's inline SVG). */
export const DEFAULT_CHART_PALETTE = [
  "#4f46e5",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#14b8a6",
];

/** Maximum number of rows enumerated by the visually-hidden data-table alternative. */
export const A11Y_TABLE_ROW_CAP = 100;

/** The result of prepareRows (the pivoted rows and the list of y series keys). */
export interface PreparedChart {
  rows: JsonObject[];
  yKeys: string[];
}

/** A reference line (a horizontal line for a target value or threshold). v1 supports only horizontal lines on the y axis. */
export interface ChartReferenceLine {
  value: number;
  label?: string;
  /** Fixed to "y" (horizontal line) in v1. Made explicit to leave room for adding "x" in the future. */
  axis?: "y";
}

/**
 * The chart's token-resolved color scheme (both renderers resolve this from their theme via
 * resolveToken and pass it in; the framework-free shape shared by renderer-react's Recharts
 * rendering and renderer-wc's inline SVG rendering).
 */
export interface ChartColors {
  /** Color of reference lines / axes (chart.axis; a mid gray that distinguishes them from data series). */
  axis: string;
  /** The knocked-out stroke of data points (color.background). */
  dotStroke: string;
  /** Text color of the x-axis labels (color.muted). Unused by renderer-react, whose axis ticks are drawn by Recharts itself. */
  axisLabel: string;
}

/**
 * The framework-free config + view model of presentChart. Both renderers derive this same shape from the
 * node's props / spec events / data rows, then only emit their own markup (Recharts vs inline SVG).
 */
export interface ChartConfig extends PreparedChart {
  kind: string;
  x: string;
  /** node.props["y"] as-is (a single key or a key list; interpreted by prepareRows / chartPointRow). */
  yProp: unknown;
  series: string | undefined;
  stacked: boolean;
  title: string | undefined;
  referenceLines: ChartReferenceLine[];
  /** figure's accessible name: the title, or the localized default label for the kind. */
  label: string;
  /**
   * Points are interactive only when pointClick is declared for this node and the kind is a hand-drawn
   * one (bar/line/area). pie/scatter stay non-interactive because they fall back to a table in WC —
   * kept identical across both renderers.
   */
  pointClickable: boolean;
}

/**
 * Derives presentChart's config from the node's props + the Spec's event declarations + the data rows.
 * The single home of the prop defaults (kind=bar / stacked=false / referenceLines=[]), the default label,
 * and the pointClickable decision, avoiding duplicating it across renderer-react / renderer-wc.
 */
export function resolveChartConfig(
  node: ComponentNode,
  spec: Pick<UISpec, "events">,
  dataRows: JsonObject[],
  messages: RendererMessages,
): ChartConfig {
  const kind = (node.props["kind"] as string) ?? "bar";
  const x = node.props["x"] as string;
  const yProp = node.props["y"];
  const series = node.props["series"] as string | undefined;
  const stacked = node.props["stacked"] === true;
  const title = node.props["title"] as string | undefined;
  const referenceLines = (node.props["referenceLines"] as unknown as ChartReferenceLine[] | undefined) ?? [];

  const { rows, yKeys } = prepareRows(dataRows, x, yProp, series);
  const label = title ?? messages.chartDefaultLabel(kind);

  const pointClickable =
    (kind === "bar" || kind === "line" || kind === "area") && hasDeclaredEvent(spec, node.id, "pointClick");

  return { kind, x, yProp, series, stacked, title, referenceLines, rows, yKeys, label, pointClickable };
}

/**
 * Builds the long-form row emitted on a data-point click (pointClick). Shared by
 * renderer-react / renderer-wc, mechanically guaranteeing that both renderers emit
 * the same payload (parity).
 *
 * - When series is specified: prepareRows pivots long→wide and loses the original
 *   long rows, so from the clicked point we reconstruct the long form
 *   `{ [x]: x value, [series]: series key, [y0]: value }` (y0 is the first of the
 *   y properties). At generation time the LLM can write a static template like
 *   `{ someKey: "$row.<series>", value: "$row.<y0>" }` (series values are
 *   data-dependent and cannot be referenced statically, so we do not adopt a
 *   design that passes the wide row through as-is).
 * - When series is not specified: prepareRows passes rows through untouched, so the
 *   wide row = the long row. We return the original row containing the x column and
 *   all y columns as-is (the same "pass the whole row" semantics as
 *   presentSpreadsheet's rowClick).
 */
export function chartPointRow(
  wideRow: JsonObject,
  yKey: string,
  x: string,
  yProp: unknown,
  series: string | undefined,
): JsonObject {
  if (series == null) return wideRow;
  const y0 = Array.isArray(yProp) ? String(yProp[0]) : String(yProp ?? "value");
  return { [x]: wideRow[x] ?? null, [series]: yKey, [y0]: wideRow[yKey] ?? null };
}

/** If there is a series column, pivots long → wide and returns the list of y series keys. */
export function prepareRows(
  rows: JsonObject[],
  x: string,
  yProp: unknown,
  series: string | undefined,
): PreparedChart {
  const yList = Array.isArray(yProp) ? (yProp as string[]) : [String(yProp ?? "value")];

  if (series == null) return { rows, yKeys: yList };

  const y = yList[0]!;
  const byX = new Map<unknown, JsonObject>();
  const seriesValues = new Set<string>();
  for (const row of rows) {
    const xValue = row[x];
    const sValue = String(row[series]);
    seriesValues.add(sValue);
    const acc = byX.get(xValue) ?? ({ [x]: xValue } as JsonObject);
    acc[sValue] = row[y] ?? null;
    byX.set(xValue, acc);
  }
  // Sort the series keys to make them stable. With the first-seen order of the row
  // data, the drawing order, color assignment, and legend order of the series would
  // vary depending on the row order of the data envelope (which SPEC leaves
  // unspecified), making the same spec look non-deterministic. The default sort()
  // is lexicographic, so a numeric series would order "10" < "2"; the numeric
  // option gives natural ordering (determinism is preserved; e.g. for series with
  // numeric labels such as month numbers or years the order becomes intuitive).
  return {
    rows: [...byX.values()],
    yKeys: [...seriesValues].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
  };
}

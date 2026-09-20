import {
  type BoundData,
  CHART_TOKEN_KEYS,
  chartPointRow,
  describeChartDataTable,
  resolveChartConfig,
  resolveToken,
  visuallyHiddenStyle,
} from "@kohaku-ui/renderer-core";
import type { ComponentNode, JsonObject } from "@kohaku-ui/spec-core";
import { el, setStyle, text } from "../dom.js";
import type { PartBuilder, RenderRuntime } from "../types.js";
import { buildChartSvg, type ChartPointHandler } from "./chart-svg.js";
import { dataStateNotice, mountBoundPart } from "./kit.js";

/**
 * presentChart — a chart (the non-React version of renderer-react's PresentChart).
 * bar/line/area use a zero-dependency inline SVG (shared prepareRows + palette); pie/scatter fall back to a visible
 * data table. In all cases a visually hidden a11y data table is always attached (same a11y as React).
 * It does not claim pixel-match (stays at semantic equivalence).
 */
export const presentChart: PartBuilder = (rt, parent, node) =>
  mountBoundPart(rt, parent, node, (state) => ({ el: renderChart(rt, node, state) }));

function renderChart(rt: RenderRuntime, node: ComponentNode, state: BoundData): Node {
  if (state.status !== "ready") return dataStateNotice(rt, state)!;

  const palette = String(resolveToken(rt.theme, CHART_TOKEN_KEYS.palette)).split(",");
  // Resolve the colors of reference lines / axes / point strokes / axis labels from tokens (equivalent to React's useToken path).
  const chartColors = {
    axis: String(resolveToken(rt.theme, CHART_TOKEN_KEYS.axis)),
    dotStroke: String(resolveToken(rt.theme, CHART_TOKEN_KEYS.dotStroke)),
    axisLabel: String(resolveToken(rt.theme, CHART_TOKEN_KEYS.axisLabel)),
  };

  // The config / view model (prop defaults, default label, pointClickable) comes from renderer-core; only the markup is emitted here.
  const cfg = resolveChartConfig(node, rt.spec, state.data.rows, rt.messages);
  const { kind, x, series, rows, yKeys, title, label } = cfg;

  // If undeclared, points stay non-interactive (rt.emit = resolveEmit is the gatekeeper).
  const point: ChartPointHandler | undefined = cfg.pointClickable
    ? {
        onPoint: (wideRow, yKey) =>
          rt.emit(node, "pointClick", { row: chartPointRow(wideRow, yKey, x, cfg.yProp, series) }, null),
        ariaLabel: (wideRow, yKey) => {
          const xVal = String(wideRow[x] ?? "");
          const val = String(wideRow[yKey] ?? "");
          return series != null ? `${x} ${xVal}、${series} ${yKey}: ${val}` : `${x} ${xVal}、${yKey}: ${val}`;
        },
      }
    : undefined;

  // Give it a name via figure's implicit role + aria-label (no role="img" — let the descendant a11y table be read).
  const figure = el("figure", { "data-kohaku": node.id, "aria-label": label }, { margin: 0, width: "100%" });

  if (title != null) {
    const caption = el("figcaption", {}, { fontSize: 13, fontWeight: 600, marginBottom: 6 });
    caption.appendChild(text(title));
    figure.appendChild(caption);
  }

  if (kind === "pie" || kind === "scatter") {
    // Not a hand-drawn SVG kind. Substitute with a visible data table (a visible table separate from the a11y table).
    figure.appendChild(visibleFallbackTable(x, yKeys, rows));
  } else {
    // When non-interactive, mark the SVG aria-hidden and defer to the a11y table. When interactive, remove aria-hidden
    // so focusable points aren't hidden from AT, and give the holder role="group" + a name (points are role="button").
    const svgHolder =
      point != null
        ? el("div", { role: "group", "aria-label": label }, { width: "100%", height: 320 })
        : el("div", { "aria-hidden": "true" }, { width: "100%", height: 320 });
    svgHolder.appendChild(buildChartSvg(cfg, chartColors, palette, point));
    figure.appendChild(svgHolder);
  }

  figure.appendChild(a11yTable(label, x, yKeys, rows));
  return figure;
}

/** Visually hidden data-table substitute (same as renderer-react's ChartDataTable). Row count is truncated at the cap. */
function a11yTable(label: string, x: string, yKeys: string[], rows: JsonObject[]): HTMLElement {
  const { headers, cells } = describeChartDataTable(x, yKeys, rows);
  const table = el("table");
  setStyle(table, visuallyHiddenStyle);
  const caption = el("caption");
  caption.appendChild(text(label));
  table.appendChild(caption);
  table.appendChild(headRow(headers));
  table.appendChild(bodyRows(cells));
  return table;
}

/** Visible fallback table for pie/scatter (a plain visible table). */
function visibleFallbackTable(x: string, yKeys: string[], rows: JsonObject[]): HTMLElement {
  const { headers, cells } = describeChartDataTable(x, yKeys, rows);
  const table = el("table", {}, { width: "100%", borderCollapse: "collapse", fontSize: 13.5 });
  table.appendChild(headRow(headers));
  table.appendChild(bodyRows(cells));
  return table;
}

function headRow(headers: string[]): HTMLElement {
  const thead = el("thead");
  const tr = el("tr");
  for (const header of headers) {
    const th = el("th", { scope: "col" });
    th.appendChild(text(header));
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  return thead;
}

function bodyRows(cells: string[][]): HTMLElement {
  const tbody = el("tbody");
  for (const row of cells) {
    const tr = el("tr");
    for (const cell of row) {
      const td = el("td");
      td.appendChild(text(cell));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  return tbody;
}

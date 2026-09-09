import { type ChartColors, type ChartConfig, isActivationKey } from "@kohaku-ui/renderer-core";
import type { JsonObject } from "@kohaku-ui/spec-core";
import { svgEl } from "../dom.js";

const W = 600;
const H = 320;
const M = { top: 8, right: 16, bottom: 28, left: 48 };

/**
 * Wiring for data-point clicks (pointClick). Since an SVG cannot sit under aria-hidden (avoiding the contradiction
 * of hiding a focusable element from AT), when interactive, chart.ts removes the holder's aria-hidden and gives
 * each point/bar role="button" + tabindex + aria-label + Enter/Space activation.
 */
export interface ChartPointHandler {
  /** Callback on point click (wide row + series key → chart.ts assembles a long row and emits). */
  onPoint: (wideRow: JsonObject, yKey: string) => void;
  /** aria-label of the interactive element (for screen-reader announcement). */
  ariaLabel: (wideRow: JsonObject, yKey: string) => string;
}

/**
 * A zero-dependency inline SVG chart (bar / line / area). A substitute for renderer-react's Recharts rendering.
 * It does not claim pixel-match (stays at semantic equivalence). Series colors come from the shared palette.
 * cfg (kind / rows / x / yKeys / stacked / referenceLines) is the framework-free view model resolved by
 * renderer-core's resolveChartConfig; point (wiring for data-point clicks) is optional.
 */
export function buildChartSvg(
  cfg: ChartConfig,
  colors: ChartColors,
  palette: string[],
  point?: ChartPointHandler,
): SVGElement {
  const { kind, rows, x, yKeys, stacked, referenceLines } = cfg;
  const color = (i: number): string => palette[i % palette.length]!;
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;

  // Max of the y axis (stacked = the series sum at each x, otherwise the max across all series). Floor of 1 to avoid division by zero.
  let max = 0;
  for (const row of rows) {
    if (stacked) {
      let sum = 0;
      for (const key of yKeys) sum += num(row[key]);
      max = Math.max(max, sum);
    } else {
      for (const key of yKeys) max = Math.max(max, num(row[key]));
    }
  }
  // Include reference-line values in the max to widen the axis domain (target lines exceeding the data stay visible; equivalent to React's ifOverflow="extendDomain").
  for (const rl of referenceLines) max = Math.max(max, num(rl.value));
  if (max <= 0) max = 1;

  const svg = svgEl("svg", {
    width: "100%",
    height: String(H),
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: "none",
    role: point != null ? "group" : "presentation",
  });

  const n = rows.length;
  const bandW = n > 0 ? plotW / n : plotW;
  const xCenter = (i: number): number => M.left + bandW * i + bandW / 2;
  const yOf = (v: number): number => M.top + plotH - (v / max) * plotH;

  /** Gives an interactive element (rect / circle) role="button" + tabindex + aria-label + click/Enter/Space. */
  const makeInteractive = (elm: SVGElement, row: JsonObject, key: string): void => {
    if (point == null) return;
    elm.setAttribute("role", "button");
    elm.setAttribute("tabindex", "0");
    elm.setAttribute("aria-label", point.ariaLabel(row, key));
    elm.style.cursor = "pointer";
    elm.addEventListener("click", () => point.onPoint(row, key));
    elm.addEventListener("keydown", (e) => {
      const ke = e as KeyboardEvent;
      if (isActivationKey(ke.key)) {
        if (ke.key === " ") ke.preventDefault();
        point.onPoint(row, key);
      }
    });
  };

  if (kind === "line" || kind === "area") {
    yKeys.forEach((key, si) => {
      const points = rows.map((row, i) => `${xCenter(i)},${yOf(num(row[key]))}`).join(" ");
      if (kind === "area") {
        const first = xCenter(0);
        const last = xCenter(n - 1);
        const baseline = M.top + plotH;
        svg.appendChild(
          svgEl("polygon", {
            points: `${first},${baseline} ${points} ${last},${baseline}`,
            fill: color(si),
            "fill-opacity": "0.25",
            stroke: "none",
          }),
        );
      }
      svg.appendChild(svgEl("polyline", { points, fill: "none", stroke: color(si), "stroke-width": "2" }));
      // Only when clickable, overlay a dot on each point (both the click target and the affordance).
      if (point != null) {
        rows.forEach((row, i) => {
          const dot = svgEl("circle", {
            cx: String(xCenter(i)),
            cy: String(yOf(num(row[key]))),
            r: "5",
            fill: color(si),
            stroke: colors.dotStroke,
            "stroke-width": "1",
          });
          makeInteractive(dot, row, key);
          svg.appendChild(dot);
        });
      }
    });
  } else {
    // bar (default). Grouped or stacked.
    const groupPad = bandW * 0.15;
    const innerW = bandW - groupPad * 2;
    rows.forEach((row, i) => {
      const x0 = M.left + bandW * i + groupPad;
      if (stacked) {
        let acc = 0;
        yKeys.forEach((key, si) => {
          const v = num(row[key]);
          const h = (v / max) * plotH;
          const y = M.top + plotH - acc - h;
          acc += h;
          const rect = svgEl("rect", {
            x: String(x0),
            y: String(y),
            width: String(innerW),
            height: String(h),
            fill: color(si),
          });
          makeInteractive(rect, row, key);
          svg.appendChild(rect);
        });
      } else {
        const each = innerW / Math.max(1, yKeys.length);
        yKeys.forEach((key, si) => {
          const v = num(row[key]);
          const h = (v / max) * plotH;
          const y = M.top + plotH - h;
          const rect = svgEl("rect", {
            x: String(x0 + each * si),
            y: String(y),
            width: String(each),
            height: String(h),
            fill: color(si),
          });
          makeInteractive(rect, row, key);
          svg.appendChild(rect);
        });
      }
    });
  }

  // Reference lines (horizontal lines for targets / thresholds + labels). Drawn after points/bars to sit in front of the data.
  for (const rl of referenceLines) {
    const yy = yOf(num(rl.value));
    svg.appendChild(
      svgEl("line", {
        x1: String(M.left),
        y1: String(yy),
        x2: String(M.left + plotW),
        y2: String(yy),
        stroke: colors.axis,
        "stroke-width": "1",
        "stroke-dasharray": "4 4",
      }),
    );
    if (rl.label != null) {
      const lbl = svgEl("text", {
        x: String(M.left + plotW),
        y: String(yy - 3),
        "text-anchor": "end",
        "font-size": "11",
        fill: colors.axis,
      });
      lbl.textContent = rl.label;
      svg.appendChild(lbl);
    }
  }

  // x-axis labels (placed at each band's center for determinism).
  rows.forEach((row, i) => {
    const label = svgEl("text", {
      x: String(xCenter(i)),
      y: String(H - 8),
      "text-anchor": "middle",
      "font-size": "12",
      fill: colors.axisLabel,
    });
    label.textContent = String(row[x] ?? "");
    svg.appendChild(label);
  });

  return svg;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

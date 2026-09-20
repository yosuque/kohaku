import {
  A11Y_TABLE_ROW_CAP,
  type ChartColors,
  type ChartConfig,
  type ChartReferenceLine,
  chartCaptionStyle,
  chartPointRow,
  chartTableStyle,
  prepareRows,
  resolveChartConfig,
  type SizingTokens,
} from "@kohaku-ui/renderer-core";
import type { JsonObject } from "@kohaku-ui/spec-core";
import { type CSSProperties, type ReactElement, type ReactNode, useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { type ImplProps, useEmitEvent, useMessages, useSizing, useSpec, useToken } from "../context.js";
import { useBoundData } from "../use-bound-data.js";
import { visuallyHiddenStyle } from "./a11y.js";
import { DataStateNotice } from "./data-states.js";

/** Callback that fires a data-point click (pointClick). Builds a long row from a wide row + series key and emits it. */
type EmitPoint = (wideRow: JsonObject, yKey: string) => void;

export function PresentChart({ node }: ImplProps): ReactNode {
  const state = useBoundData(node);
  const emit = useEmitEvent(node);
  const spec = useSpec();
  const messages = useMessages();
  const sizing = useSizing();
  const palette = String(useToken("chart.palette")).split(",");
  // Resolve from tokens: the reference-line/axis color (a mid gray distinguishable from data series) and the dots' knockout stroke (= background color).
  const axisColor = String(useToken("chart.axis"));
  const bgColor = String(useToken("color.background"));

  // The config / view model (prop defaults, default label, pointClickable) comes from renderer-core; only the markup is emitted here.
  // resolveChartConfig does a long→wide pivot + sort (prepareRows) over every row, so it is memoized:
  // an unrelated re-render (e.g. a sibling's $state-driven visibility flip bubbling through the shared
  // parent) should not redo that work when node.props / spec.events / the resolved data / messages are
  // all unchanged. Keyed on the actual inputs rather than `node`/`spec` themselves, since row-templated
  // nodes get a freshly allocated `node` object on every render (see use-bound-data.ts's own doc note).
  const dataForConfig = state.status === "ready" ? state.data : undefined;
  const cfg = useMemo(
    () => resolveChartConfig(node, spec, dataForConfig?.rows ?? [], messages),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on node.props/spec.events, not node/spec identity
    [node.props, spec.events, dataForConfig, messages],
  );

  if (state.status !== "ready") return <DataStateNotice state={state} />;

  const { x, series, rows, yKeys, title, label } = cfg;
  const colors: Pick<ChartColors, "axis" | "dotStroke"> = { axis: axisColor, dotStroke: bgColor };

  // If undeclared, points stay non-interactive (governance is gated by useEmitEvent = resolveEmit).
  const emitPoint: EmitPoint | undefined = cfg.pointClickable
    ? (wideRow, yKey) => emit("pointClick", { row: chartPointRow(wideRow, yKey, x, cfg.yProp, series) })
    : undefined;

  return (
    // Give the chart a name via figure's implicit "figure" role + aria-label. Do not add role="img"
    // (adding it makes descendants presentational, so the data-table alternative below becomes unreadable to assistive tech).
    <figure data-kohaku={node.id} aria-label={label} style={{ margin: 0, width: "100%" }}>
      {title != null && <figcaption style={chartCaptionStyle(sizing)}>{title}</figcaption>}
      {/* recharts' SVG is meaningless to assistive tech, so hide it and convey the content via the data table below instead.
          Clickable points are also placed under aria-hidden (due to Recharts constraints, keyboard operation is provided only on the WC side). */}
      <div aria-hidden="true" style={{ width: "100%", height: 320 }}>
        <ResponsiveContainer width="100%" height="100%">
          {renderChart(cfg, colors, palette, emitPoint)}
        </ResponsiveContainer>
      </div>
      <ChartDataTable label={label} x={x} yKeys={yKeys} rows={rows} sizing={sizing} />
    </figure>
  );
}

/** The chart's visually hidden data-table alternative (for screen readers). Rows are truncated at the cap. */
function ChartDataTable({
  label,
  x,
  yKeys,
  rows,
  sizing,
}: {
  label: string;
  x: string;
  yKeys: string[];
  rows: JsonObject[];
  sizing: SizingTokens;
}): ReactNode {
  const shown = rows.slice(0, A11Y_TABLE_ROW_CAP);
  // The a11y alternative must stay visually hidden regardless of sizing, so visuallyHiddenStyle's
  // position/width/height/clip win over chartTableStyle's own width -- only borderCollapse/fontSize
  // survive from it (a purely additive consistency pickup; the table was previously unstyled beyond
  // visuallyHiddenStyle).
  const style: CSSProperties = { ...chartTableStyle(sizing), ...visuallyHiddenStyle };
  return (
    <table style={style}>
      <caption>{label}</caption>
      <thead>
        <tr>
          <th scope="col">{x}</th>
          {yKeys.map((key) => (
            <th key={key} scope="col">
              {key}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {shown.map((row, i) => (
          // Key is content-based (row[x]); the index is appended only as a tiebreaker for duplicate
          // x values, not as the primary key -- this is a visually-hidden a11y table of stateless cells.
          // biome-ignore lint/suspicious/noArrayIndexKey: content-based key with an index tiebreaker for duplicates.
          <tr key={`${String(row[x])}-${i}`}>
            <td>{String(row[x] ?? "")}</td>
            {yKeys.map((key) => (
              <td key={key}>{String(row[key] ?? "")}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Test-only export for series pivot/sort (a re-export of renderer-core's prepareRows). */
export const prepareRowsForTest = prepareRows;

/** Converts reference lines (target values/thresholds) into Recharts ReferenceLine elements. ifOverflow extends the axis domain so they are always shown. */
function referenceLineEls(referenceLines: ChartReferenceLine[], axisColor: string): ReactElement[] {
  return referenceLines.map((rl, i) => (
    // Content-based key (rl.value); the index is appended only as a tiebreaker for reference lines
    // sharing the same value -- these are stateless Recharts overlay elements.
    <ReferenceLine
      // biome-ignore lint/suspicious/noArrayIndexKey: content-based key with an index tiebreaker for duplicates.
      key={`ref-${i}-${rl.value}`}
      y={rl.value}
      stroke={axisColor}
      strokeDasharray="4 4"
      ifOverflow="extendDomain"
      {...(rl.label != null ? { label: rl.label } : {})}
    />
  ));
}

/**
 * Clickable dots for line/area (a render function). Recharts passes cx/cy/index/dataKey at each point.
 * Draw only when pointClickable (= serves as both click target and affordance). Because Recharts' SVG is
 * under aria-hidden, do not add tabIndex (avoid the contradiction of focusable + AT-hidden; pointer only).
 */
function clickableDot(opts: {
  rows: JsonObject[];
  yKey: string;
  color: string;
  emitPoint: EmitPoint;
  dotStroke: string;
}) {
  const { rows, yKey, color, emitPoint, dotStroke } = opts;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Recharts' dot render props are any
  return (props: any): ReactElement => {
    const { cx, cy, index, key } = props;
    return (
      // Recharts' SVG is under aria-hidden (see the function docstring above), so this cannot be made a
      // focusable/keyboard-operable control without the AT-hidden + focusable contradiction; pointer-only
      // is the deliberate choice, hence a plain <circle onClick> rather than a role + keyboard handler.
      // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only by design inside an aria-hidden SVG chart (see comment above).
      <circle
        key={key ?? `dot-${yKey}-${index}`}
        cx={cx}
        cy={cy}
        r={4}
        fill={color}
        stroke={dotStroke}
        strokeWidth={1}
        style={{ cursor: "pointer" }}
        onClick={() => emitPoint(rows[index]!, yKey)}
      />
    );
  };
}

function renderChart(
  cfg: ChartConfig,
  colors: Pick<ChartColors, "axis" | "dotStroke">,
  palette: string[],
  emitPoint: EmitPoint | undefined,
) {
  const { kind, x, rows, yKeys, stacked, referenceLines } = cfg;
  const { axis: axisColor, dotStroke: bgColor } = colors;
  const color = (i: number): string => palette[i % palette.length]!;
  const common = { data: rows as object[], margin: { top: 8, right: 16, bottom: 4, left: 8 } };
  const refs = referenceLineEls(referenceLines, axisColor);

  switch (kind) {
    case "line":
      return (
        <LineChart {...common}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey={x} fontSize={12} />
          <YAxis fontSize={12} width={80} />
          <Tooltip />
          {yKeys.length > 1 && <Legend />}
          {refs}
          {yKeys.map((key, i) => (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              stroke={color(i)}
              dot={
                emitPoint != null
                  ? clickableDot({ rows, yKey: key, color: color(i), emitPoint, dotStroke: bgColor })
                  : false
              }
            />
          ))}
        </LineChart>
      );
    case "area":
      return (
        <AreaChart {...common}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey={x} fontSize={12} />
          <YAxis fontSize={12} width={80} />
          <Tooltip />
          {yKeys.length > 1 && <Legend />}
          {refs}
          {yKeys.map((key, i) => (
            <Area
              key={key}
              type="monotone"
              dataKey={key}
              stroke={color(i)}
              fill={color(i)}
              fillOpacity={0.25}
              stackId={stacked ? "stack" : undefined}
              {...(emitPoint != null
                ? { dot: clickableDot({ rows, yKey: key, color: color(i), emitPoint, dotStroke: bgColor }) }
                : {})}
            />
          ))}
        </AreaChart>
      );
    case "pie": {
      const y = yKeys[0]!;
      return (
        <PieChart>
          <Tooltip />
          <Legend />
          <Pie data={rows as object[]} dataKey={y} nameKey={x} outerRadius="80%" label>
            {rows.map((row, i) => (
              // Base the key on content (the x value), not the array index. With an index key,
              // adding/reordering rows cross-wires the Cell's DOM state. Append index to guard against same-name collisions.
              // biome-ignore lint/suspicious/noArrayIndexKey: content-based key with an index tiebreaker for duplicates.
              <Cell key={`${String(row[x])}-${i}`} fill={color(i)} />
            ))}
          </Pie>
        </PieChart>
      );
    }
    case "scatter": {
      const y = yKeys[0]!;
      return (
        <ScatterChart {...common}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey={x} fontSize={12} />
          <YAxis dataKey={y} fontSize={12} width={80} />
          <Tooltip />
          {refs}
          <Scatter data={rows as object[]} fill={color(0)} />
        </ScatterChart>
      );
    }
    default:
      return (
        <BarChart {...common}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey={x} fontSize={12} />
          <YAxis fontSize={12} width={80} />
          <Tooltip />
          {yKeys.length > 1 && <Legend />}
          {refs}
          {yKeys.map((key, i) => (
            <Bar
              key={key}
              dataKey={key}
              fill={color(i)}
              stackId={stacked ? "stack" : undefined}
              radius={[3, 3, 0, 0]}
              {...(emitPoint != null
                ? {
                    cursor: "pointer",
                    onClick: (_data: unknown, index: number) => emitPoint(rows[index]!, key),
                  }
                : {})}
            />
          ))}
        </BarChart>
      );
  }
}

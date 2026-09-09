import type { ColumnType, DataShape, JsonObject, TabularColumn, TabularData } from "@kohaku-ui/spec-core";
import { DEMO_FISCAL_YEAR } from "../intents/vocab.js";
import type { SalesRepo } from "./repo.js";
import {
  CHANNEL_LABELS,
  type Channel,
  GROUP_AXIS_LABELS,
  REGION_LABELS,
  type Region,
  type SalesRecord,
  type SalesTarget,
} from "./types.js";

/**
 * The concrete operations of DomainPort (= the op of query://sales/{op}).
 * All deterministic: the same params + the same dataVersion return the same result.
 * Invariant (lightweight since read-only): an aggregate value always equals the total sum of the records.
 */

export interface QueryArgs {
  [key: string]: string | number | undefined;
}

function num(v: string | number | undefined): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function str(v: string | number | undefined): string | undefined {
  return v == null || v === "" ? undefined : String(v);
}

/**
 * Dimension code -> display label. region / channel map the code to its display label (product is already a product name, so passed through).
 * For display cell values only: query parameters, filters, and drilldown keys are handled as codes (japan / direct, etc.).
 * The catalog side reverse-maps so that drilldown can be received as either a label or a code.
 */
function dimLabel(dimension: string, code: string): string {
  if (dimension === "region") return REGION_LABELS[code as Region] ?? code;
  if (dimension === "channel") return CHANNEL_LABELS[code as Channel] ?? code;
  return code;
}

/** Sums value per key with a Map (single-measure version). Not used for the two-measure summary aggregation. */
function sumByKey<K, V>(rows: V[], keyFn: (row: V) => K, valueFn: (row: V) => number): Map<K, number> {
  const map = new Map<K, number>();
  for (const row of rows) {
    const key = keyFn(row);
    map.set(key, (map.get(key) ?? 0) + valueFn(row));
  }
  return map;
}

/** Rounds a ratio to a percentage (1 decimal place). Denominator 0 returns null (the missing-value convention). */
function ratioPercent(numerator: number, denom: number): number | null {
  return denom > 0 ? Math.round((numerator / denom) * 1000) / 10 : null;
}

/** Rounds a growth rate to a percentage (1 decimal place). Baseline 0 returns null (the missing-value convention). */
function growthPercent(cur: number, prev: number): number | null {
  return prev > 0 ? Math.round((cur / prev - 1) * 1000) / 10 : null;
}

/** Falls an unknown or unspecified metric back to the default revenue (symmetric for summary / trend). */
function resolveMetric(metric: "units" | "revenue" | undefined): "revenue" | "units" {
  return metric === "units" ? "units" : "revenue";
}

/**
 * Reads a string query arg, defaulting to `fallback` when missing/empty. Deliberately does NOT validate against
 * a fixed set of allowed values: several call sites (summary's groupBy, trend's granularity, kpi's metric, and
 * their shapeOf counterparts) let an unrecognized value pass through unchanged, to be resolved downstream by a
 * ternary chain, a Map lookup, or another helper (e.g. resolveMetric) — a validating enum reader would silently
 * change behavior at those sites. Where the actual op additionally normalizes the value (summary/trend's
 * metric, and shapeOf's trend case), use readMetric instead.
 */
function strDefault(args: QueryArgs, key: string, fallback: string): string {
  return str(args[key]) ?? fallback;
}

/** Reads the units|revenue metric arg (shared by summary/trend), defaulting an unspecified or unrecognized value to revenue. */
function readMetric(args: QueryArgs): "units" | "revenue" {
  return resolveMetric(str(args["metric"]) as "units" | "revenue" | undefined);
}

/** Sums revenue over a set of records (repeated across kpi's yoy/total branches). */
function sumRevenue(records: readonly SalesRecord[]): number {
  return records.reduce((s, r) => s + r.revenue, 0);
}

/** Targets for a fiscal year, optionally narrowed to a quarter (repeated between kpi's target_attainment and targets). */
function targetsFor(repo: SalesRepo, fy: number, q: number | undefined): SalesTarget[] {
  return repo.targets.filter((t) => t.fiscalYear === fy && (q == null || t.quarter === q));
}

function filterRecords(repo: SalesRepo, args: QueryArgs): SalesRecord[] {
  const fy = num(args["fy"]);
  const q = num(args["q"]);
  const region = str(args["region"]);
  const productId = str(args["productId"]);
  const channel = str(args["channel"]);
  return repo.records.filter(
    (r) =>
      (fy == null || r.fiscalYear === fy) &&
      (q == null || r.quarter === q) &&
      (region == null || r.region === region) &&
      (productId == null || r.productId === productId) &&
      (channel == null || r.channel === channel),
  );
}

/**
 * The single definition of columns. The rendering form (TabularColumn: key/label/type) and the shape metadata
 * (DataShape: name/type/role) are derived from here, so columns are not managed twice across the query body and shapeOf (preventing sync drift).
 */
interface ColumnSpec {
  name: string;
  label: string;
  type: ColumnType;
  role?: "dimension" | "measure" | "time";
}

/** ColumnSpec[] -> TabularData.columns (for rendering) */
function toColumns(specs: ColumnSpec[]): TabularColumn[] {
  return specs.map((s) => ({ key: s.name, label: s.label, type: s.type }));
}

/** ColumnSpec[] -> DataShape (shape metadata; does not include the row data = the "water") */
function toShape(specs: ColumnSpec[], rowCountHint?: number): DataShape {
  return {
    columns: specs.map((s) => ({
      name: s.name,
      type: s.type,
      ...(s.role != null ? { role: s.role } : {}),
    })),
    ...(rowCountHint != null ? { rowCountHint } : {}),
  };
}

function summaryColumns(groupBy: string): ColumnSpec[] {
  return [
    { name: groupBy, label: groupLabel(groupBy), type: "string", role: "dimension" },
    { name: "revenue", label: "Revenue (JPY)", type: "number", role: "measure" },
    { name: "units", label: "Units", type: "number", role: "measure" },
  ];
}

function trendColumns(granularity: string, metric: string): ColumnSpec[] {
  return [
    { name: granularity, label: granularity === "month" ? "Month" : "Quarter", type: "string", role: "time" },
    {
      name: metric,
      label: metric === "revenue" ? "Revenue (JPY)" : "Units",
      type: "number",
      role: "measure",
    },
  ];
}

function recordsColumns(): ColumnSpec[] {
  return [
    { name: "month", label: "Month", type: "string", role: "dimension" },
    { name: "region", label: "Region", type: "string", role: "dimension" },
    { name: "product", label: "Product", type: "string", role: "dimension" },
    { name: "channel", label: "Channel", type: "string", role: "dimension" },
    // The units label is unified across aggregation (summary/trend) and records, so the same
    // units column does not get a different label across views.
    { name: "units", label: "Units", type: "number", role: "measure" },
    { name: "revenue", label: "Revenue (JPY)", type: "number", role: "measure" },
  ];
}

function kpiColumns(): ColumnSpec[] {
  return [
    { name: "label", label: "Metric", type: "string", role: "dimension" },
    { name: "value", label: "Value", type: "number", role: "measure" },
    { name: "format", label: "Format", type: "string" },
    { name: "note", label: "Note", type: "string" },
  ];
}

function targetsColumns(): ColumnSpec[] {
  return [
    { name: "region", label: "Region", type: "string", role: "dimension" },
    { name: "actual", label: "Actual (JPY)", type: "number", role: "measure" },
    { name: "target", label: "Target (JPY)", type: "number", role: "measure" },
    { name: "attainment", label: "Attainment (%)", type: "number", role: "measure" },
    // Missing-value reason (the missing-value convention). Only rows with no target set (target<=0) get a value; normal rows are null (blank in the table).
    { name: "note", label: "Note", type: "string" },
  ];
}

/**
 * Aggregates revenue by groupBy (region|product|channel). Sorts in descending order of metric (revenue|units;
 * default revenue), and topN slicing uses the same criterion ("units top N" is the top N in descending units).
 */
export function summary(repo: SalesRepo, args: QueryArgs): TabularData {
  const groupBy = strDefault(args, "groupBy", "region") as "region" | "product" | "channel";
  // The metric used as the basis for sorting and topN slicing. Unknown values fall back to the default revenue (so sorting is not broken by undefined comparisons).
  const metric = readMetric(args);
  const rows = filterRecords(repo, args);
  const grouped = new Map<string, { revenue: number; units: number }>();
  for (const r of rows) {
    const key =
      groupBy === "product" ? repo.productName(r.productId) : groupBy === "channel" ? r.channel : r.region;
    const acc = grouped.get(key) ?? { revenue: 0, units: 0 };
    acc.revenue += r.revenue;
    acc.units += r.units;
    grouped.set(key, acc);
  }
  let result = [...grouped.entries()]
    // Map the displayed value to the display label. The grouping key was already aggregated as a code.
    .map(
      ([key, v]) => ({ [groupBy]: dimLabel(groupBy, key), revenue: v.revenue, units: v.units }) as JsonObject,
    )
    .sort((a, b) => (b[metric] as number) - (a[metric] as number));
  // topN is also subject to the same 1-500 clamp as _limit (preventing counterintuitive slice behavior for negative or non-numeric values).
  // An invalid value (non-numeric or <= 0) falls to undefined, skips the slice, and returns all rows.
  const topN = clampReservedLimit(num(args["topN"]));
  if (topN != null) result = result.slice(0, topN);
  return {
    columns: toColumns(summaryColumns(groupBy)),
    rows: result,
    dataVersion: repo.dataVersion(),
  };
}

/** Monthly/quarterly time series. */
export function trend(repo: SalesRepo, args: QueryArgs): TabularData {
  const granularity = strDefault(args, "granularity", "month") as "month" | "quarter";
  // Unknown values fall back to the default revenue (symmetric with summary; M1). Without this fallback, r[metric] is undefined -> the aggregate becomes NaN.
  const metric = readMetric(args);
  const rows = filterRecords(repo, args);
  // Quarters are on a fiscal-year basis (starts in April; Q1=4-6/Q2=7-9/Q3=10-12/Q4=1-3). Calendar-year quarters and timezone boundaries are not considered.
  const grouped = sumByKey(
    rows,
    (r) => (granularity === "quarter" ? `FY${r.fiscalYear} Q${r.quarter}` : r.month),
    (r) => r[metric],
  );
  const result = [...grouped.entries()]
    .map(([key, value]) => ({ [granularity]: key, [metric]: value }) as JsonObject)
    .sort((a, b) => String(a[granularity]).localeCompare(String(b[granularity])));
  return {
    columns: toColumns(trendColumns(granularity, metric)),
    rows: result,
    dataVersion: repo.dataVersion(),
  };
}

/**
 * Records (with server-side paging/sorting).
 * If the reserved parameters are unspecified, the default applies (default sort = month -> region -> productId, limit=100, first page).
 * `_sort`/`_dir` sort by column, `_limit`/`_cursor` page, and nextCursor is returned if there is more.
 */
export function records(repo: SalesRepo, args: QueryArgs): TabularData {
  const dataVersion = repo.dataVersion();
  // Default stable sort (month -> region -> productId). This is the legacy behavior, so it is applied first regardless of whether a reserved sort is present.
  const matched = filterRecords(repo, args).sort(
    (a, b) =>
      a.month.localeCompare(b.month) ||
      a.region.localeCompare(b.region) ||
      a.productId.localeCompare(b.productId),
  );
  const cols = recordsColumns();
  const toRow = (r: SalesRecord): JsonObject =>
    ({
      month: r.month,
      // region / channel map the displayed value to the display label. No effect on filtering, which uses r.region/r.channel (codes).
      region: dimLabel("region", r.region),
      product: repo.productName(r.productId),
      channel: dimLabel("channel", r.channel),
      units: r.units,
      revenue: r.revenue,
    }) as JsonObject;

  // Reserved sort (_sort/_dir). Stably layered on top of the default order (unspecified or unknown column keeps the default order).
  const sortKeyRaw = str(args["_sort"]);
  const sortKey = sortKeyRaw != null && cols.some((c) => c.name === sortKeyRaw) ? sortKeyRaw : null;
  const dir = str(args["_dir"]) === "asc" ? "asc" : "desc";

  // The cursor also embeds the sort context. It is the signature of the sort actually applied; the default stable sort is "_".
  // dir is meaningful only for a reserved sort (irrelevant in the default order, so the default is always "_").
  const sortSig = sortKey == null ? "_" : `${sortKey}.${dir}`;

  const total = matched.length;
  // Paging: _limit (clamped to 1-500; <= 0 or non-numeric falls back to the default) -> legacy limit (also clamped to
  // 1-500, preventing full-volume retrieval and invalid values via the old parameter) -> default 100, in that order.
  // _cursor is the opaque `${offset}:${sortSig}:${dataVersion}`.
  const limit = clampReservedLimit(num(args["_limit"])) ?? clampReservedLimit(num(args["limit"])) ?? 100;
  const offset = parseCursorOffset(str(args["_cursor"]), dataVersion, sortSig);
  const nextOffset = offset + limit;

  // A reserved sort may order by a label-mapped column (region/product/channel), so it must label-convert all rows
  // before sorting. In the default order the labels of rows outside the page window are never observed, so the
  // conversion is applied only to the sliced page (avoiding wasted per-row work on the ~5x rows that are cut away).
  let rows: JsonObject[];
  if (sortKey != null) {
    const sign = dir === "asc" ? 1 : -1;
    // mapped is a locally owned array returned by .map(), so an in-place sort is safe (no extra copy needed).
    const mapped = matched.map(toRow);
    mapped.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av ?? "").localeCompare(String(bv ?? ""));
      return cmp * sign;
    });
    rows = mapped.slice(offset, nextOffset);
  } else {
    rows = matched.slice(offset, nextOffset).map(toRow);
  }
  return {
    columns: toColumns(cols),
    rows,
    dataVersion,
    total,
    // Return the next-page cursor only when there is more (opaque; embeds the version and sort signature, and resets to the start if either mismatches).
    ...(nextOffset < total ? { nextCursor: `${nextOffset}:${sortSig}:${dataVersion}` } : {}),
  };
}

/**
 * Restores the offset from the opaque cursor `${offset}:${sortSig}:${dataVersion}`.
 * If the version and sort signature do not both match the current request (after a data update or a sort change),
 * or the format is invalid, resets to the start (0) (preventing duplicated or missing rows).
 * Since offset and sortSig contain no `:`, and dataVersion (sales@<seed>#bump-N) also contains no `:`,
 * the first two `:` split it into three, and the remainder can be taken as dataVersion as-is.
 * An old two-element cursor without a sort signature (`offset:dataVersion`) has only one `:`, so it resets to the start.
 */
function parseCursorOffset(cursor: string | undefined, dataVersion: string, sortSig: string): number {
  if (cursor == null) return 0;
  const i1 = cursor.indexOf(":");
  if (i1 < 0) return 0;
  const i2 = cursor.indexOf(":", i1 + 1);
  if (i2 < 0) return 0;
  const offset = Number(cursor.slice(0, i1));
  const sig = cursor.slice(i1 + 1, i2);
  const version = cursor.slice(i2 + 1);
  if (version !== dataVersion || sig !== sortSig || !Number.isInteger(offset) || offset < 0) return 0;
  return offset;
}

/**
 * Clamps the row-count limit to 1-500 (shared by records' reserved `_limit` and summary's topN).
 * Prevents full-volume retrieval via huge values and abuse of <= 0 or non-numeric values.
 * An invalid value (non-numeric or <= 0) returns undefined, letting the caller fall back to its default (records: legacy limit -> 100; summary: unlimited).
 */
function clampReservedLimit(raw: number | undefined): number | undefined {
  if (raw == null || !Number.isFinite(raw) || raw < 1) return undefined;
  return Math.min(Math.floor(raw), 500);
}

/**
 * A percent-format KPI row. The missing-value contract in one place: pass value=null with the reason in
 * note when the denominator is missing (KpiCard renders null as "—", preventing misreading as 0%).
 */
function percentKpiRow(label: string, value: number | null, note: string): JsonObject {
  return { label, value, format: "percent", note };
}

/**
 * A percent KPI row for the "current vs. baseline" shape shared by yoy / target_attainment: when the baseline is
 * present, show `value` with `note`; otherwise null with `missingNote` (the missing-value convention). `value`
 * is passed pre-computed — growthPercent/ratioPercent already resolve to null once their own denominator is <= 0,
 * so `hasBaseline` only decides which note text applies. Not used by top_region, which has an extra guard
 * (no top region at all) that does not fit this shape.
 */
function percentKpiOrMissing(
  label: string,
  hasBaseline: boolean,
  value: number | null,
  note: string,
  missingNote: string,
): JsonObject {
  return percentKpiRow(label, hasBaseline ? value : null, hasBaseline ? note : missingNote);
}

/** Inputs shared by every KPI builder (the company-wide scope established by kpi()). */
interface KpiContext {
  repo: SalesRepo;
  fy: number;
  q: number | undefined;
  current: SalesRecord[];
  currentRevenue: number;
}

/**
 * One row-builder per metric (scope: reads only fy/q from args, via KpiContext — no dimension filters here).
 * Keyed by metric name; an unrecognized or unspecified metric uses `default` (total_revenue), matching the
 * previous switch's default branch.
 */
const KPI_BUILDERS: Record<string, (ctx: KpiContext) => JsonObject> = {
  yoy: ({ repo, fy, q, currentRevenue }) => {
    const priorRevenue = sumRevenue(filterRecords(repo, { fy: fy - 1, q }));
    return percentKpiOrMissing(
      "YoY",
      priorRevenue > 0,
      growthPercent(currentRevenue, priorRevenue),
      `vs. FY${fy - 1}`,
      `No baseline data (FY${fy - 1})`,
    );
  },
  top_region: ({ current, currentRevenue }) => {
    const byRegion = sumByKey(
      current,
      (r) => r.region,
      (r) => r.revenue,
    );
    const top = [...byRegion.entries()].sort((a, b) => b[1] - a[1])[0];
    return top != null && currentRevenue > 0
      ? percentKpiRow("Top region", ratioPercent(top[1], currentRevenue), `${REGION_LABELS[top[0]]} (share)`)
      : percentKpiRow("Top region", null, "No revenue in period");
  },
  target_attainment: ({ repo, fy, q, currentRevenue }) => {
    const targetTotal = targetsFor(repo, fy, q).reduce((s, t) => s + t.targetRevenue, 0);
    return percentKpiOrMissing(
      "Target attainment",
      targetTotal > 0,
      ratioPercent(currentRevenue, targetTotal),
      "Company-wide",
      "No target set",
    );
  },
  default: ({ fy, q, currentRevenue }) => ({
    label: "Total revenue",
    value: currentRevenue,
    format: "currency",
    // The note reflects the aggregation scope: with q the value is a quarterly total, so the note carries the
    // quarter too (otherwise a quarterly figure would read as the full-year total).
    note: q != null ? `FY${fy} Q${q}` : `FY${fy}`,
  }),
};

/**
 * A single KPI (1 row). metric: total_revenue | yoy | top_region | target_attainment
 *
 * Scope contract: a KPI is a company-wide aggregate and filters records only by the fiscal period (fy/q). It does
 * not accept dimension filters such as region/channel/productId. This keeps the numerator (current-period revenue) and
 * the denominator (the base for prior-year, target, and share) always on the same population, eliminating the latent
 * bug where the presence/absence of a dimension filter makes the numerator and denominator scopes diverge. The callers
 * (catalog's sales.kpi_overview / sales.target_attainment) also pass only fy/q.
 *
 * Missing-value handling: when the denominator is 0 (no prior-year or target data at all), value is set to null
 * instead of 0%, and note gives the reason. KpiCard renders value=null as "—", preventing misreading as "zero growth / unmet target".
 */
export function kpi(repo: SalesRepo, args: QueryArgs): TabularData {
  const metric = strDefault(args, "metric", "total_revenue");
  const fy = num(args["fy"]) ?? DEMO_FISCAL_YEAR;
  const q = num(args["q"]);
  const current = filterRecords(repo, { fy, q });
  const currentRevenue = sumRevenue(current);
  // Object.hasOwn (not a bare `in`/index lookup) so a metric value that names a prototype key (e.g.
  // "toString", "constructor") cannot resolve to Object.prototype's own method instead of a builder function,
  // which would make `build` non-callable / return a non-JsonObject and break the TabularData contract.
  const build = Object.hasOwn(KPI_BUILDERS, metric) ? KPI_BUILDERS[metric]! : KPI_BUILDERS["default"]!;
  const row = build({ repo, fy, q, current, currentRevenue });

  return {
    columns: toColumns(kpiColumns()),
    rows: [row],
    dataVersion: repo.dataVersion(),
  };
}

/** Actual vs target by region. */
export function targets(repo: SalesRepo, args: QueryArgs): TabularData {
  const fy = num(args["fy"]) ?? DEMO_FISCAL_YEAR;
  const q = num(args["q"]);
  const actualByRegion = sumByKey<string, SalesRecord>(
    filterRecords(repo, { fy: fy, q: q }),
    (r) => r.region,
    (r) => r.revenue,
  );
  const targetByRegion = sumByKey(
    targetsFor(repo, fy, q),
    (t) => t.region,
    (t) => t.targetRevenue,
  );

  const result = [...targetByRegion.entries()]
    .map(([region, target]) => {
      const actual = actualByRegion.get(region) ?? 0;
      return {
        // The displayed value is the display label. Aggregation and reconciliation are done with the region code.
        region: dimLabel("region", region),
        actual,
        target,
        // Denominator 0 (no target set) is set to null so it is not misread as "attainment 0%", and note gives the reason
        // (the missing-value convention; the same treatment as kpi's target_attainment; the table cell is null -> rendered blank).
        attainment: ratioPercent(actual, target),
        note: target > 0 ? null : "No target set",
      } as JsonObject;
    })
    .sort((a, b) => (b["actual"] as number) - (a["actual"] as number));

  return {
    columns: toColumns(targetsColumns()),
    rows: result,
    dataVersion: repo.dataVersion(),
  };
}

function groupLabel(groupBy: string): string {
  return GROUP_AXIS_LABELS[groupBy as keyof typeof GROUP_AXIS_LABELS] ?? GROUP_AXIS_LABELS.region;
}

export const OPERATIONS = { summary, trend, records, kpi, targets } as const;
export type OperationName = keyof typeof OPERATIONS;

/** For describeShape: the column metadata of each operation (does not include row data). Column definitions are unified in *Columns. */
export function shapeOf(op: string, args: QueryArgs): DataShape | null {
  switch (op) {
    case "summary": {
      const groupBy = strDefault(args, "groupBy", "region");
      return toShape(summaryColumns(groupBy), groupBy === "product" ? 6 : groupBy === "channel" ? 3 : 4);
    }
    case "trend": {
      const granularity = strDefault(args, "granularity", "month");
      // Mirror trend()'s actual column set: an unrecognized metric must normalize the same way here as it
      // does in trend() itself, or the two column sets diverge for that input.
      const metric = readMetric(args);
      return toShape(trendColumns(granularity, metric), granularity === "month" ? 12 : 8);
    }
    case "records":
      return toShape(recordsColumns(), 100);
    case "kpi":
      return toShape(kpiColumns(), 1);
    case "targets":
      return toShape(targetsColumns(), 4);
    default:
      return null;
  }
}

import type { ResolveOptions } from "@kohaku-ui/data-binding";
import type { ComponentNode, JsonObject, JsonValue, TabularColumn } from "@kohaku-ui/spec-core";

/** Local sort state (column + ascending/descending). */
export interface SortState {
  field: string;
  dir: "asc" | "desc";
}

/** The runtime payload type for rowClick (emit("rowClick", { row })). */
export type SpreadsheetRowRuntime = { row: JsonObject };

/** The runtime payload type for sortChange (emit("sortChange", { value })). Mirrors props.sortBy's own shape. */
export type SpreadsheetSortRuntime = { value: SortState };

/**
 * The next SortState when a user toggles sort on a column: a newly-clicked column starts
 * descending; re-clicking the already-active column cycles desc -> asc -> desc. The single source
 * of truth for this rule (shared by the remote controller's toggleSort and, indirectly, both
 * renderers' sortChange emission, which uses the value this returns).
 */
export function nextSortState(sort: SortState | undefined, colKey: string): SortState {
  return {
    field: colKey,
    dir: sort?.field === colKey && sort.dir === "desc" ? "asc" : "desc",
  };
}

/**
 * Formats a cell value. For a number column with a numeric value, digit grouping;
 * for an object, JSON stringification; for null, an empty string. Everything else
 * passes through via String().
 */
export function formatCell(value: JsonValue | undefined, col: TabularColumn, locale: string): string {
  if (value == null) return "";
  if (col.type === "number" && typeof value === "number") {
    return value.toLocaleString(locale);
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * A comparator that compares two rows on a single field (numeric difference when
 * both are numbers, otherwise localeCompare). dir flips ascending/descending. The
 * sole comparison rule for local sorting (serverSide=false).
 */
export function compareRows(a: JsonObject, b: JsonObject, sort: SortState, locale: string): number {
  const av = a[sort.field];
  const bv = b[sort.field];
  const cmp =
    typeof av === "number" && typeof bv === "number"
      ? av - bv
      : String(av ?? "").localeCompare(String(bv ?? ""), locale);
  return sort.dir === "asc" ? cmp : -cmp;
}

/**
 * Locally sorts the row array and returns a **new array** (the original array is
 * not modified). If sort is undefined, returns an order-preserving copy.
 */
export function sortRows(rows: JsonObject[], sort: SortState | undefined, locale: string): JsonObject[] {
  const result = [...rows];
  if (sort == null) return result;
  result.sort((a, b) => compareRows(a, b, sort, locale));
  return result;
}

/**
 * Builds the query options passed to binding.resolve in serverSide mode. The shape
 * that conditionally adds keys based on the presence of sort / cursor / pageSize
 * was verbatim-isomorphic between React ⇄ WC; this makes it the single source of
 * truth.
 */
export function buildResolveOptions(
  sort: SortState | undefined,
  cursor: string | undefined,
  pageSize: number | undefined,
): ResolveOptions {
  return {
    ...(sort != null ? { sort: { key: sort.field, dir: sort.dir } } : {}),
    ...(cursor != null || pageSize != null
      ? {
          page: {
            ...(cursor != null ? { cursor } : {}),
            ...(pageSize != null ? { limit: pageSize } : {}),
          },
        }
      : {}),
  };
}

/**
 * Uses declared columns if present, otherwise the data's columns (an unspecified
 * type defaults to string). data may be missing only columns before it is ready
 * (equivalent to React's data?.columns ?? []).
 */
export function resolveColumns(node: ComponentNode, data: { columns?: TabularColumn[] }): TabularColumn[] {
  const declared = node.props["columns"] as
    | { key: string; label?: string; type?: TabularColumn["type"] }[]
    | undefined;
  if (declared != null && declared.length > 0) {
    return declared.map((c) => ({ key: c.key, label: c.label, type: c.type ?? "string" }));
  }
  return data.columns ?? [];
}

/**
 * Absolute upper limit of rows presentSpreadsheet lays out locally (consistent with propsSchema's
 * pageSize max). A local (non-serverSide) spreadsheet has no server-side paging to fall back on, so
 * without this cap an unbounded reference-passed dataset would be rendered in full — this is the
 * safety net regardless of whether props.pageSize is declared. Large datasets are serverSide's domain.
 */
export const SPREADSHEET_HARD_ROW_CAP = 500;

/**
 * Local sort + pageSize slicing (when not serverSide).
 * sortRows → slice to min(pageSize, SPREADSHEET_HARD_ROW_CAP). The original array is not modified.
 * Returns the identical `rows` reference (no copy at all) when there is no sort AND no truncation —
 * callers that key optimistic state off row-array identity (see the editable working copy) depend on
 * this to know when the underlying data actually changed.
 */
export function applyLocalView(
  rows: JsonObject[],
  sort: SortState | undefined,
  pageSize: number | undefined,
  locale: string,
): JsonObject[] {
  const limit = pageSize != null ? Math.min(pageSize, SPREADSHEET_HARD_ROW_CAP) : SPREADSHEET_HARD_ROW_CAP;
  if (sort == null) {
    if (rows.length <= limit) return rows;
    return rows.slice(0, limit);
  }
  return sortRows(rows, sort, locale).slice(0, limit);
}

/**
 * The "Showing N of T" footer's population count T for a local (non-serverSide) spreadsheet. T is
 * data.total when the source reported one (e.g. an upstream-truncated result), otherwise the full
 * local row count (data.rows.length) — that is the true population when no total was reported, so a
 * pageSize/hard-cap truncation with no declared total is still disclosed honestly. Returns undefined
 * when nothing was truncated (T <= shown), signaling the footer should not render at all.
 */
export function localFooterTotal(
  data: { total?: number; rows: unknown[] },
  shown: number,
): number | undefined {
  const total = data.total ?? data.rows.length;
  return total > shown ? total : undefined;
}

/**
 * Deterministically generates a row key (shared by presentSpreadsheet /
 * presentList). Since the schema has no concept of a primary-key column, it
 * deterministically serializes the display-column values. To guard against name
 * collisions (multiple rows with identical content), it also appends the index at
 * the end.
 */
export function rowKey(row: JsonObject, columns: TabularColumn[], index: number): string {
  const base =
    columns.length > 0 ? JSON.stringify(columns.map((col) => row[col.key] ?? null)) : JSON.stringify(row);
  return `${base}#${index}`;
}

/**
 * A column header's fully-derived sort affordance (label / numeric alignment / aria-sort /
 * the ▲▼ arrow glyph). Both renderers would otherwise compute this same shape inline and have to
 * stay byte-for-byte in sync by hand; this is the single source of truth. desc -> "▼",
 * everything else active -> "▲", inactive -> undefined (no arrow, no aria-sort).
 */
export interface SortHeaderDescriptor {
  label: string;
  numeric: boolean;
  active: boolean;
  ariaSort: "ascending" | "descending" | undefined;
  arrow: "▲" | "▼" | undefined;
}

/** Derives a column header's sort-affordance view model from the column definition and current sort state. */
export function describeSortHeader(col: TabularColumn, sort: SortState | undefined): SortHeaderDescriptor {
  const active = sort?.field === col.key;
  const ariaSort: "ascending" | "descending" | undefined = active
    ? sort!.dir === "asc"
      ? "ascending"
      : "descending"
    : undefined;
  const arrow: "▲" | "▼" | undefined = active ? (sort!.dir === "desc" ? "▼" : "▲") : undefined;
  return {
    label: col.label ?? col.key,
    numeric: col.type === "number",
    active,
    ariaSort,
    arrow,
  };
}

// --- Style constants/functions shared verbatim by both renderers (React's style prop and WC's setStyle consume the same shape). ---

/** The resolved token colors the spreadsheet presenter depends on (each renderer resolves its own theme). */
export interface SpreadsheetTokens {
  border: string;
  headerBg: string;
  accent: string;
  muted: string;
}

/** The header cell's base look (independent of sort state; the sort affordance lives in the embedded button). */
export function spreadsheetThStyle(tokens: Pick<SpreadsheetTokens, "headerBg" | "border">) {
  return {
    background: tokens.headerBg,
    borderBottom: `2px solid ${tokens.border}`,
    padding: 0,
    whiteSpace: "nowrap",
  } as const;
}

/**
 * The sort-trigger button embedded in a th. Resets the button's default chrome so it still reads as a th, and
 * expands the hit area to the full cell so it can also be activated by keyboard. Numeric columns right-align
 * the trigger content to match the column's own alignment.
 */
export function spreadsheetSortButtonStyle(options: { numeric: boolean }) {
  const { numeric } = options;
  return {
    display: "flex",
    alignItems: "center",
    gap: 4,
    justifyContent: numeric ? ("flex-end" as const) : ("flex-start" as const),
    width: "100%",
    background: "none",
    border: "none",
    font: "inherit",
    color: "inherit",
    padding: "8px 10px",
    cursor: "pointer",
    userSelect: "none",
  } as const;
}

/** A body cell's style (numeric columns right-align with tabular figures for column alignment). */
export function spreadsheetTdStyle(options: { numeric: boolean }) {
  const { numeric } = options;
  return {
    padding: "7px 10px",
    textAlign: numeric ? ("right" as const) : ("left" as const),
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  } as const;
}

/** The serverSide footer bar (total count + first/next pager buttons). */
export function spreadsheetFooterBarStyle(tokens: Pick<SpreadsheetTokens, "muted">) {
  return {
    display: "flex",
    alignItems: "center",
    gap: 10,
    fontSize: 12,
    color: tokens.muted,
    padding: "6px 2px",
  } as const;
}

/** The local (non-serverSide) "N of total" notice shown below the table when rows were truncated. */
export function spreadsheetFooterTotalStyle(tokens: Pick<SpreadsheetTokens, "muted">) {
  return {
    fontSize: 12,
    color: tokens.muted,
    padding: "6px 2px",
  } as const;
}

/** The serverSide pager buttons (first page / next page). */
export function spreadsheetPagerButtonStyle(tokens: Pick<SpreadsheetTokens, "border" | "accent">) {
  return {
    background: "none",
    border: `1px solid ${tokens.border}`,
    borderRadius: 6,
    color: tokens.accent,
    font: "inherit",
    fontSize: 12,
    padding: "3px 10px",
    cursor: "pointer",
  } as const;
}

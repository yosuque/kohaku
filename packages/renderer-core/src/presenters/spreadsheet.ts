import type { ResolveOptions } from "@kohaku-ui/data-binding";
import type { ComponentNode, JsonObject, JsonValue, TabularColumn } from "@kohaku-ui/spec-core";
import { DEFAULT_SIZING, type SizingTokens } from "../theme.js";

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

// --- Editable cells (props.editable + cellEdit) -----------------------------------------------

/**
 * Identifies which cell is currently in edit mode (or none, when the field itself is absent from
 * the renderer's local state). `invalid` marks a failed coercion attempt on the currently-typed
 * value — the cell stays in edit mode (aria-invalid) rather than reverting to the button. Shared
 * shape for both renderers' local "which cell is being edited" state.
 */
export type SpreadsheetCellEdit = { rowIndex: number; column: string; invalid?: boolean };

/**
 * The runtime payload type for cellEdit (invoke("cellEdit", { row, value })). `row` is the row as it
 * was **before** this edit (i.e. the currently-displayed row, including any earlier edits from the
 * working copy, but not this one); `value` carries the edited column, its coerced new value, the
 * previous value, and the row's display index.
 */
export type SpreadsheetCellEditRuntime = {
  row: JsonObject;
  value: { column: string; value: JsonValue; previousValue: JsonValue; rowIndex: number };
};

/**
 * The editable text a cell's <input> starts with when entering edit mode. Unlike formatCell (which
 * is for display: locale-grouped numbers, JSON-stringified objects), this is meant to be re-parsed
 * by coerceCellInput, so numbers are plain (no digit grouping) and null is the empty string.
 */
export function cellDraft(value: JsonValue | undefined, _col: TabularColumn): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** The result of coerceCellInput: either a successfully-parsed JsonValue, or a rejected input (kept open, aria-invalid). */
export type CellCoercion = { ok: true; value: JsonValue } | { ok: false };

/**
 * Coerces a cell <input>'s raw text per the column's declared type (TabularColumn.type), matching
 * data-binding's write-side expectations:
 * - number: "" -> null; a non-numeric string -> invalid; otherwise the parsed number.
 * - boolean: "true"/"1"/"yes" -> true; "false"/"0"/"no" -> false (case-insensitive); "" -> null;
 *   anything else -> invalid.
 * - date: "" -> null; otherwise the raw string passes through unvalidated (no calendar parsing here).
 * - string (and unspecified): the raw string passes through as-is, including "".
 */
export function coerceCellInput(raw: string, col: TabularColumn): CellCoercion {
  switch (col.type) {
    case "number": {
      if (raw === "") return { ok: true, value: null };
      const n = Number(raw);
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
    }
    case "boolean": {
      if (raw === "") return { ok: true, value: null };
      const lower = raw.trim().toLowerCase();
      if (lower === "true" || lower === "1" || lower === "yes") return { ok: true, value: true };
      if (lower === "false" || lower === "0" || lower === "no") return { ok: true, value: false };
      return { ok: false };
    }
    case "date":
      return { ok: true, value: raw === "" ? null : raw };
    default:
      return { ok: true, value: raw };
  }
}

/**
 * An optimistic in-memory overlay of pending cell edits on top of a rows array, keyed by the
 * *reference identity* of that array (`source`) so it is discarded automatically the moment new
 * data supersedes it (a fresh fetch always produces a new rows array — see applyLocalView's
 * identical-reference guarantee for the no-op case). Persistence is the host's responsibility;
 * this overlay exists purely so the edited value is visible immediately, before any round trip.
 */
export interface RowsWorkingCopy {
  /** The rows array this working copy was built against. */
  source: JsonObject[];
  /** display row index -> that row with its pending edits applied. */
  edits: Map<number, JsonObject>;
}

/**
 * Records a single cell edit on top of `rows`, returning a new RowsWorkingCopy. If `copy` was built
 * against a different `rows` reference (new data arrived since the last edit), it is discarded
 * first — the caller never needs to detect staleness itself, just always pass the current `rows`.
 */
export function commitCellEdit(
  copy: RowsWorkingCopy | undefined,
  rows: JsonObject[],
  rowIndex: number,
  column: string,
  value: JsonValue,
): RowsWorkingCopy {
  const edits = copy != null && copy.source === rows ? new Map(copy.edits) : new Map<number, JsonObject>();
  const base = edits.get(rowIndex) ?? rows[rowIndex] ?? {};
  edits.set(rowIndex, { ...base, [column]: value });
  return { source: rows, edits };
}

/**
 * The rows actually displayed: `rows` with any pending edits from `copy` applied. Returns `rows`
 * itself (the identical reference) when there is nothing to apply — no working copy, a stale one
 * (built against a different rows reference — see commitCellEdit), or an empty one — so a caller
 * memoizing on this result's identity does not re-render needlessly.
 */
export function effectiveRows(rows: JsonObject[], copy: RowsWorkingCopy | undefined): JsonObject[] {
  if (copy == null || copy.source !== rows || copy.edits.size === 0) return rows;
  return rows.map((row, i) => copy.edits.get(i) ?? row);
}

/** The idle (non-editing) cell's button chrome — reset to read as a plain td while remaining focusable/clickable. */
export function spreadsheetCellEditButtonStyle(options: { numeric: boolean }) {
  const { numeric } = options;
  return {
    display: "block",
    width: "100%",
    textAlign: numeric ? ("right" as const) : ("left" as const),
    fontVariantNumeric: "tabular-nums",
    background: "none",
    border: "none",
    font: "inherit",
    color: "inherit",
    padding: 0,
    cursor: "pointer",
  } as const;
}

/** The editing cell's <input> chrome. */
export function spreadsheetCellEditInputStyle(
  tokens: Pick<SpreadsheetTokens, "border">,
  options: { numeric: boolean },
  sizing: SizingTokens = DEFAULT_SIZING,
) {
  const { numeric } = options;
  return {
    display: "block",
    width: "100%",
    boxSizing: "border-box" as const,
    textAlign: numeric ? ("right" as const) : ("left" as const),
    font: "inherit",
    border: `1px solid ${tokens.border}`,
    borderRadius: sizing.radiusSm,
    padding: "1px 3px",
  } as const;
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

/**
 * The header cell's base look (independent of sort state; the sort affordance lives in the embedded
 * button). `muted` is required: every call site must supply the token-derived header color, so a call
 * site that forgets it is a compile error rather than a silently inherited color.
 */
export function spreadsheetThStyle(
  tokens: Pick<SpreadsheetTokens, "headerBg" | "border" | "muted">,
  sizing: SizingTokens = DEFAULT_SIZING,
) {
  return {
    background: tokens.headerBg,
    color: tokens.muted,
    fontSize: sizing.fontSm,
    fontWeight: 600,
    borderBottom: `1px solid ${tokens.border}`,
    padding: 0,
    whiteSpace: "nowrap",
  } as const;
}

/**
 * The sort-trigger button embedded in a th. Resets the button's default chrome so it still reads as a th, and
 * expands the hit area to the full cell so it can also be activated by keyboard. Numeric columns right-align
 * the trigger content to match the column's own alignment.
 */
export function spreadsheetSortButtonStyle(
  options: { numeric: boolean },
  sizing: SizingTokens = DEFAULT_SIZING,
) {
  const { numeric } = options;
  return {
    display: "flex",
    alignItems: "center",
    gap: sizing.space1,
    justifyContent: numeric ? ("flex-end" as const) : ("flex-start" as const),
    width: "100%",
    background: "none",
    border: "none",
    font: "inherit",
    color: "inherit",
    padding: `${sizing.space2} ${sizing.space3}`,
    cursor: "pointer",
    userSelect: "none",
  } as const;
}

/** A body cell's style (numeric columns right-align with tabular figures for column alignment). */
export function spreadsheetTdStyle(options: { numeric: boolean }, sizing: SizingTokens = DEFAULT_SIZING) {
  const { numeric } = options;
  return {
    padding: `${sizing.space2} ${sizing.space3}`,
    textAlign: numeric ? ("right" as const) : ("left" as const),
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  } as const;
}

/** The serverSide footer bar (total count + first/next pager buttons). */
export function spreadsheetFooterBarStyle(
  tokens: Pick<SpreadsheetTokens, "muted">,
  sizing: SizingTokens = DEFAULT_SIZING,
) {
  return {
    display: "flex",
    alignItems: "center",
    gap: sizing.space2,
    fontSize: sizing.fontSm,
    color: tokens.muted,
    padding: `${sizing.space2} 2px`,
  } as const;
}

/** The local (non-serverSide) "N of total" notice shown below the table when rows were truncated. */
export function spreadsheetFooterTotalStyle(
  tokens: Pick<SpreadsheetTokens, "muted">,
  sizing: SizingTokens = DEFAULT_SIZING,
) {
  return {
    fontSize: sizing.fontSm,
    color: tokens.muted,
    padding: `${sizing.space2} 2px`,
  } as const;
}

/** The serverSide pager buttons (first page / next page). */
export function spreadsheetPagerButtonStyle(
  tokens: Pick<SpreadsheetTokens, "border" | "accent">,
  sizing: SizingTokens = DEFAULT_SIZING,
) {
  return {
    background: "none",
    border: `1px solid ${tokens.border}`,
    borderRadius: sizing.radiusMd,
    color: tokens.accent,
    font: "inherit",
    fontSize: sizing.fontSm,
    padding: `${sizing.space1} ${sizing.space3}`,
    cursor: "pointer",
  } as const;
}

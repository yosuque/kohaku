import {
  applyLocalView,
  type CellCoercion,
  cellDraft,
  chartTableStyle,
  coerceCellInput,
  commitCellEdit,
  describeSortHeader,
  effectiveRows,
  formatCell,
  hasDeclaredEvent,
  isActivationKey,
  localFooterTotal,
  type RowsWorkingCopy,
  resolveColumns,
  rowKey,
  type SpreadsheetCellEdit,
  type SpreadsheetCellEditRuntime,
  type SpreadsheetRowRuntime,
  type SpreadsheetSortRuntime,
  spreadsheetCellEditButtonStyle,
  spreadsheetCellEditInputStyle,
  spreadsheetFooterBarStyle,
  spreadsheetFooterTotalStyle,
  spreadsheetPagerButtonStyle,
  spreadsheetSortButtonStyle,
  spreadsheetTdStyle,
  spreadsheetThStyle,
} from "@kohaku-ui/renderer-core";
import { type JsonObject, resolveBoundRef, type TabularColumn } from "@kohaku-ui/spec-core";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  type ImplProps,
  useEmitEvent,
  useLocale,
  useMessages,
  useRenderer,
  useSizing,
  useSpec,
  useToken,
} from "../context.js";
import { useDataInvalidation } from "../data-invalidation.js";
import { useSpecStateSelector } from "../spec-state.js";
import { useBoundData } from "../use-bound-data.js";
import { useInvokeAction } from "../use-invoke-action.js";
import { useSpreadsheetRemote } from "../use-spreadsheet-remote.js";
import { DataStateNotice } from "./data-states.js";

// The runtime payload types for rowClick / sortChange / cellEdit use renderer-core as the single
// source of truth (the public API is unchanged via re-export).
export type { SpreadsheetCellEditRuntime, SpreadsheetRowRuntime, SpreadsheetSortRuntime };

export function PresentSpreadsheet({ node }: ImplProps): ReactNode {
  // serverSide (opt-in, default false): when true, sorting/paging is done not locally but
  // by re-fetching via binding.resolve(ref, {page, sort}) (for large datasets). Default false keeps the current behavior.
  const serverSide = node.props["serverSide"] === true;
  const pageSize = node.props["pageSize"] as number | undefined;
  const editable = node.props["editable"] === true;

  const emit = useEmitEvent(node);
  const { invoke: invokeCellEdit } = useInvokeAction(node);
  const spec = useSpec();
  const messages = useMessages();
  const locale = useLocale();
  const { binding } = useRenderer();
  const bus = useDataInvalidation();
  // The effective ref (data.bind resolved against $state) — kept following by the remote controller
  // via setRef (see use-spreadsheet-remote.ts) so a sibling filter's $state change doesn't leave
  // sort/page refetches pinned to the ref that was current when the controller was first built.
  // Selectively subscribed (useSpecStateSelector): re-renders only when the effective ref's value
  // changes, not on every unrelated $state.set.
  const effectiveRef = useSpecStateSelector((values) =>
    node.data != null ? resolveBoundRef(node.data, values) : undefined,
  );

  // A row click is an "operation that changes intent," so it goes upstream via a Spec-declared event
  // (the design contrast point with in-column sorting, which is local state — see useSpreadsheetRemote).
  // The serverSide re-fetch state machine (controller wiring, snapshot subscription, declaredSort
  // signature tracking on Spec re-delivery) has renderer-core's controller as the single source of
  // truth, wrapped by this hook the same way useBoundData wraps BoundDataController. Called before
  // useBoundData below so `snap.remoteActive` is known when deciding whether base should be enabled.
  const { ctrl, snap } = useSpreadsheetRemote(node, { binding, bus, serverSide, pageSize, effectiveRef });
  const { sort, cursor, remote, remoteActive } = snap;

  // base (useBoundData's own un-paged, full-dataset resolution) is disabled only while the remote
  // controller is *actually* the active fetch source — i.e. serverSide is true AND
  // snap.remoteActive (sortBy/pageSize declared, or the user has interacted). A serverSide spreadsheet
  // that declares neither and hasn't been interacted with yet still needs base to supply its initial
  // display (exactly like non-serverSide) — disabling base unconditionally on `serverSide` alone would
  // leave such a spreadsheet permanently blank, since the remote controller only fetches once active.
  const base = useBoundData(node, { enabled: !(serverSide && remoteActive) });

  const sizing = useSizing();
  const border = String(useToken("color.border"));
  const headerBg = String(useToken("color.surface"));
  const accent = String(useToken("color.primary"));
  const muted = String(useToken("color.muted"));

  // During/after a serverSide re-fetch, use remote as the display state; otherwise use base (useBoundData).
  const state = serverSide && remote != null ? remote : base;

  const rowClickable = hasDeclaredEvent(spec, node.id, "rowClick");
  // Whether a Spec-declared sortChange event should be emitted on each user sort toggle. Never
  // emitted from the Spec-driven syncDeclaredSort inside useSpreadsheetRemote — only a user
  // interaction with the header button below fires it.
  const sortChangeable = hasDeclaredEvent(spec, node.id, "sortChange");

  const data = state.status === "ready" ? state.data : undefined;
  const columns = useMemo(() => resolveColumns(node, data ?? {}), [node.props, data]);

  const rows = useMemo(() => {
    if (data == null) return [];
    // In serverSide, the server has already applied sorting/paging, so locally we neither reorder nor slice.
    if (serverSide) return data.rows;
    // Local sorting/page slicing (the comparison rules have renderer-core's applyLocalView / sortRows as the single source of truth).
    return applyLocalView(data.rows, sort, pageSize, locale);
  }, [data, sort, pageSize, locale, serverSide]);

  // Editable cells: an optimistic working copy of pending edits, keyed on `rows`'s own reference
  // identity (see commitCellEdit/effectiveRows) so a fresh fetch (a brand new `rows` array)
  // automatically discards any copy built against the previous data — no explicit invalidation
  // needed here. `editing` identifies which single cell (if any) currently shows an <input> instead
  // of its button; `invalid` on it marks a failed coerceCellInput attempt (kept open, aria-invalid).
  const [copy, setCopy] = useState<RowsWorkingCopy | undefined>(undefined);
  const [editing, setEditing] = useState<SpreadsheetCellEdit | undefined>(undefined);
  const displayRows = useMemo(() => effectiveRows(rows, copy), [rows, copy]);

  // Enter and Escape both resolve through the same onBlur handler (by calling .blur()) rather than
  // running their own commit/cancel logic, so there is exactly one code path that ever mutates state
  // for a given edit session — no risk of a trailing native blur re-committing after Enter already did.
  const cancelledRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (editing != null) inputRef.current?.focus();
  }, [editing]);

  const commitEdit = (rowIndex: number, col: TabularColumn, raw: string): void => {
    const coercion: CellCoercion = coerceCellInput(raw, col);
    if (!coercion.ok) {
      setEditing({ rowIndex, column: col.key, invalid: true });
      return;
    }
    const row = displayRows[rowIndex];
    if (row == null) {
      setEditing(undefined);
      return;
    }
    const previousValue = row[col.key] ?? null;
    if (coercion.value === previousValue) {
      setEditing(undefined); // unchanged: close without emitting cellEdit
      return;
    }
    setCopy((prev) => commitCellEdit(prev, rows, rowIndex, col.key, coercion.value));
    setEditing(undefined);
    const runtime: SpreadsheetCellEditRuntime = {
      row,
      value: { column: col.key, value: coercion.value, previousValue, rowIndex },
    };
    void invokeCellEdit("cellEdit", runtime as unknown as JsonObject);
  };

  if (state.status !== "ready") return <DataStateNotice state={state} />;

  // The local (non-serverSide) truncation footer's population count (undefined when nothing was
  // truncated). serverSide has its own total/pager footer below (data.total is already server-reported).
  const localTotal = serverSide ? undefined : localFooterTotal(state.data, displayRows.length);

  return (
    <div data-kohaku={node.id} style={{ width: "100%", overflowX: "auto" }}>
      <table style={chartTableStyle(sizing)}>
        <thead>
          <tr>
            {columns.map((col) => {
              // aria-sort / label / arrow are all derived by renderer-core's describeSortHeader (single source of truth
              // shared with renderer-wc); it emits ascending/descending only on the currently sorted column.
              const h = describeSortHeader(col, sort);
              return (
                <th
                  key={col.key}
                  aria-sort={h.ariaSort}
                  style={spreadsheetThStyle({ headerBg, border, muted }, sizing)}
                >
                  {/* Move the sort trigger into a button so it can also be activated by keyboard. To keep the appearance as a th,
                      reset the button's default styles and expand the click area to the full cell. */}
                  <button
                    type="button"
                    onClick={() => {
                      const next = ctrl.toggleSort(col.key);
                      // SortState -> JsonObject: a plain { field, dir } shape, just without an index
                      // signature — structurally a JsonObject at runtime.
                      if (sortChangeable) emit("sortChange", { value: next as unknown as JsonObject });
                    }}
                    style={spreadsheetSortButtonStyle({ numeric: h.numeric }, sizing)}
                  >
                    {h.label}
                    {h.active && (
                      <span aria-hidden="true" style={{ color: accent }}>
                        {h.arrow}
                      </span>
                    )}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {displayRows.map((row, i) => (
            <tr
              // The key does not rely on the array index alone; it also weaves in the row content. With a pure index key,
              // adding/reordering rows tends to cross-wire DOM state (diffing), so we build a key from the serialized row content
              // plus an index appended for same-name collisions (see rowKey).
              key={rowKey(row, columns, i)}
              onClick={rowClickable ? () => emit("rowClick", { row }) : undefined}
              // Add role="button" + tabIndex to the tr so a row click can also be activated by keyboard.
              // Concern: adding a role to a tr weakens the table's semantics (reading it out as a row).
              // If problems arise, remove the role and instead switch to placing an operable element with an aria-label inside the row.
              // editable drops role/tabIndex/keydown entirely (an editable cell's own button/input is
              // already interactive; nesting that inside a role="button" row trips axe's
              // nested-interactive rule) — onClick stays wired for rowClick, but each cell's own
              // button/input stops propagation so an edit interaction never also fires rowClick.
              role={!editable && rowClickable ? "button" : undefined}
              tabIndex={!editable && rowClickable ? 0 : undefined}
              onKeyDown={
                !editable && rowClickable
                  ? (e) => {
                      if (isActivationKey(e.key)) {
                        // For Space, suppress the default page scroll before firing.
                        if (e.key === " ") e.preventDefault();
                        emit("rowClick", { row });
                      }
                    }
                  : undefined
              }
              style={{
                cursor: rowClickable ? "pointer" : "default",
                borderBottom: `1px solid ${border}`,
              }}
            >
              {columns.map((col) => {
                if (!editable) {
                  return (
                    <td key={col.key} style={spreadsheetTdStyle({ numeric: col.type === "number" }, sizing)}>
                      {formatCell(row[col.key], col, locale)}
                    </td>
                  );
                }
                const isEditingThis = editing?.rowIndex === i && editing.column === col.key;
                const numeric = col.type === "number";
                if (isEditingThis) {
                  return (
                    <td key={col.key} style={spreadsheetTdStyle({ numeric }, sizing)}>
                      <input
                        ref={inputRef}
                        type="text"
                        aria-label={messages.spreadsheetEditCell(col.label ?? col.key)}
                        aria-invalid={editing.invalid ? "true" : undefined}
                        defaultValue={cellDraft(row[col.key], col)}
                        style={spreadsheetCellEditInputStyle({ border }, { numeric }, sizing)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            e.currentTarget.blur();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            cancelledRef.current = true;
                            e.currentTarget.blur();
                          }
                        }}
                        onBlur={(e) => {
                          if (cancelledRef.current) {
                            cancelledRef.current = false;
                            setEditing(undefined);
                            return;
                          }
                          commitEdit(i, col, e.currentTarget.value);
                        }}
                      />
                    </td>
                  );
                }
                return (
                  <td key={col.key} style={spreadsheetTdStyle({ numeric }, sizing)}>
                    <button
                      type="button"
                      aria-label={messages.spreadsheetEditCell(col.label ?? col.key)}
                      style={spreadsheetCellEditButtonStyle({ numeric })}
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing({ rowIndex: i, column: col.key });
                      }}
                    >
                      {formatCell(row[col.key], col, locale)}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {serverSide ? (
        // serverSide: total count + paging (back to first / next). Whether a next page exists is judged by nextCursor.
        <div style={spreadsheetFooterBarStyle({ muted }, sizing)}>
          {state.data.total != null && (
            <span>
              {messages.spreadsheetTotal(state.data.total.toLocaleString(locale), displayRows.length)}
            </span>
          )}
          {cursor != null && (
            <button
              type="button"
              onClick={() => ctrl.goFirstPage()}
              style={spreadsheetPagerButtonStyle({ border, accent }, sizing)}
            >
              {messages.spreadsheetFirstPage}
            </button>
          )}
          {state.data.nextCursor != null && (
            <button
              type="button"
              onClick={() => ctrl.goNextPage(state.data.nextCursor!)}
              style={spreadsheetPagerButtonStyle({ border, accent }, sizing)}
            >
              {messages.spreadsheetNextPage}
            </button>
          )}
        </div>
      ) : (
        localTotal != null && (
          <div style={spreadsheetFooterTotalStyle({ muted }, sizing)}>
            {messages.spreadsheetTotal(localTotal.toLocaleString(locale), displayRows.length)}
          </div>
        )
      )}
    </div>
  );
}

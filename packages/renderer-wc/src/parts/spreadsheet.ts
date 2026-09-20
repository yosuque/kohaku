import {
  applyLocalView,
  type BoundData,
  cellDraft,
  chartTableStyle,
  createSpreadsheetRemoteController,
  describeSortHeader,
  effectiveRows,
  formatCell,
  hasDeclaredEvent,
  isActivationKey,
  localFooterTotal,
  planCellEdit,
  type RowsWorkingCopy,
  resolveColumns,
  type SizingTokens,
  type SortState,
  type SpreadsheetCellEdit,
  type SpreadsheetTokens,
  spreadsheetCellEditButtonStyle,
  spreadsheetCellEditInputStyle,
  spreadsheetFooterBarStyle,
  spreadsheetFooterTotalStyle,
  spreadsheetPagerButtonStyle,
  spreadsheetSortButtonStyle,
  spreadsheetTdStyle,
  spreadsheetThStyle,
} from "@kohaku-ui/renderer-core";
import {
  type ComponentNode,
  type JsonObject,
  resolveBoundRef,
  type TabularColumn,
  type TabularData,
} from "@kohaku-ui/spec-core";
import { el, text } from "../dom.js";
import type { PartBuilder, RenderRuntime } from "../types.js";
import { dataStateNotice, tokenStr } from "./kit.js";

/**
 * presentSpreadsheet — a table (same behavior as renderer-react's PresentSpreadsheet).
 * In-column sorting is an "operation that does not change intent" so it uses local state; a row click is an "operation
 * that changes intent" so it goes upstream via a Spec-declared event. In serverSide (opt-in), sorting/paging is done via
 * binding.resolve refetches. Current sort is indicated by aria-sort / ▲▼. When props.editable, cells become
 * button/input pairs that emit cellEdit via the invoke path (see attemptCommit below).
 *
 * The serverSide refetch state machine's single source of truth is renderer-core's SpreadsheetRemoteController.
 */
export const presentSpreadsheet: PartBuilder = (rt, parent, node) => {
  const border = tokenStr(rt, "color.border");
  const headerBg = tokenStr(rt, "color.surface");
  const accent = tokenStr(rt, "color.primary");
  const muted = tokenStr(rt, "color.muted");

  const serverSide = node.props["serverSide"] === true;
  const ref = node.data?.$ref;
  const pageSize = node.props["pageSize"] as number | undefined;
  const declaredSort = node.props["sortBy"] as unknown as SortState | undefined;
  const editable = node.props["editable"] === true;
  const rowClickable = hasDeclaredEvent(rt.spec, node.id, "rowClick");
  // Whether a Spec-declared sortChange event should be emitted on each user sort toggle. Never
  // emitted from the Spec-driven syncDeclaredSort path — only a user click/keydown on the header
  // button below fires it.
  const sortChangeable = hasDeclaredEvent(rt.spec, node.id, "sortChange");

  const ctrl = createSpreadsheetRemoteController({
    binding: rt.binding,
    bus: rt.bus,
    ref,
    pageSize,
    serverSide,
    declaredSort,
  });

  // base (resolved from the Spec-derived version). The BoundDataController guarantees last-write-wins, invalidation, and freshness matching.
  let base: BoundData = { status: "idle" };
  // The base attach is toggled on/off as ctrl's remoteActive flag changes (see syncBaseAttach below,
  // mirroring renderer-react's PresentSpreadsheet: `enabled: !(serverSide && snap.remoteActive)`). base
  // is disabled only while the remote controller is *actually* the active fetch source (sortBy/pageSize
  // declared, or the user has interacted) — a serverSide spreadsheet that declares neither and hasn't
  // been interacted with yet still relies on base for its display, exactly like non-serverSide.
  let baseDetach: () => void = () => {};
  let baseEnabled: boolean | null = null;

  let current: ChildNode = document.createComment(`kohaku:bound:${node.id}`);
  parent.appendChild(current);
  const swap = (next: Node): void => {
    current.replaceWith(next);
    current = next as ChildNode;
  };

  const displayed = (): BoundData => {
    const { remote } = ctrl.getSnapshot();
    return serverSide && remote != null ? remote : base;
  };

  // Editable cells: an optimistic working copy of pending edits, keyed on the local-view rows
  // array's own reference identity (see commitCellEdit/effectiveRows — mirrors renderer-react's
  // useMemo-backed `rows`). rowsCache replicates useMemo's caching by hand: applyLocalView allocates
  // a *new* array on every call whenever it actually sorts or slices, so recomputing it on every
  // rerender() (editing/copy toggles included, not just new data) would make the working copy look
  // stale against its own freshly-recomputed source and silently drop every edit the instant it's
  // applied. Cache key: data reference + sort's value signature (serverSide/pageSize are fixed for
  // this part instance's lifetime, so they need not be part of the key).
  let rowsCache: { data: TabularData; sortSig: string; result: JsonObject[] } | null = null;
  const computeRows = (data: TabularData, sort: SortState | undefined): JsonObject[] => {
    if (serverSide) return data.rows;
    const sortSig = sort != null ? JSON.stringify(sort) : "";
    if (rowsCache != null && rowsCache.data === data && rowsCache.sortSig === sortSig) {
      return rowsCache.result;
    }
    const result = applyLocalView(data.rows, sort, pageSize, rt.locale);
    rowsCache = { data, sortSig, result };
    return result;
  };

  let copy: RowsWorkingCopy | undefined;
  let editing: SpreadsheetCellEdit | undefined;
  // Tracks which `editing` identity was last focused, so a rerender caused by something other than
  // *starting* an edit (or retrying after an invalid one) does not keep stealing focus back to the
  // input — mirrors a React useEffect's dependency-array semantics ([editing]).
  let lastFocusedEditing: SpreadsheetCellEdit | undefined;

  const startEdit = (rowIndex: number, col: TabularColumn): void => {
    editing = { rowIndex, column: col.key };
    rerender();
  };

  const cancelEdit = (): void => {
    editing = undefined;
    rerender();
  };

  /**
   * The sole commit path for both Enter and blur (native or triggered by Escape/Enter closing the
   * input). Guarded by `editing` identity + `input.isConnected` so a trailing native blur — fired
   * when a prior Enter/Escape already rerendered this cell back to its button and detached this very
   * input — is a no-op rather than a second commit.
   */
  const attemptCommit = (
    rows: JsonObject[],
    input: HTMLInputElement,
    rowIndex: number,
    col: TabularColumn,
  ): void => {
    if (editing?.rowIndex !== rowIndex || editing.column !== col.key || !input.isConnected) return;
    const plan = planCellEdit({ rows, copy, rowIndex, col, raw: input.value });
    switch (plan.kind) {
      case "invalid":
        // Keep the same input node (no rerender): a full rebuild would replace it with a fresh one
        // reset to the cell's original value, destroying the very text the user is trying to fix.
        // Refocus it too — a blur-triggered attempt has already lost focus by this point.
        editing = { rowIndex, column: col.key, invalid: true };
        input.setAttribute("aria-invalid", "true");
        input.focus();
        return;
      case "close":
        editing = undefined; // vanished row, or unchanged value: close without emitting cellEdit
        rerender();
        return;
      case "commit":
        copy = plan.copy;
        editing = undefined;
        rerender();
        // SpreadsheetCellEditRuntime -> JsonObject: a plain nested-object shape, just without index
        // signatures — structurally a JsonObject at runtime.
        rt.invoke(node, "cellEdit", plan.runtime as unknown as JsonObject, null, () => {});
        return;
    }
  };

  const rerender = (): void => {
    const snap = ctrl.getSnapshot();
    const state = displayed();
    const rows = state.status === "ready" ? computeRows(state.data, snap.sort) : [];
    const rendered = renderTable(rt, node, state, {
      serverSide,
      sort: snap.sort,
      cursor: snap.cursor,
      rowClickable,
      editable,
      rows,
      copy,
      editing,
      colors: { border, headerBg, accent, muted },
      onToggleSort: (colKey) => {
        const next = ctrl.toggleSort(colKey);
        // SortState -> JsonObject: a plain { field, dir } shape, just without an index signature —
        // structurally a JsonObject at runtime.
        if (sortChangeable) rt.emit(node, "sortChange", { value: next as unknown as JsonObject }, null);
      },
      onFirstPage: () => ctrl.goFirstPage(),
      onNextPage: (next) => ctrl.goNextPage(next),
      onStartEdit: startEdit,
      onCommit: (input, rowIndex, col) => attemptCommit(rows, input, rowIndex, col),
      onCancel: cancelEdit,
    });
    swap(rendered);
    if (editing != null && editing !== lastFocusedEditing && rendered instanceof Element) {
      (rendered.querySelector("input") as HTMLInputElement | null)?.focus();
    }
    lastFocusedEditing = editing;
  };

  // (Re-)attaches base with the currently-correct `enabled` flag, only when that flag actually
  // changed since the last attach (toggling attach/detach is not free — a fresh attach synchronously
  // reports idle/loading again). Node/spec are fixed for this part instance's lifetime (a Spec swap
  // rebuilds the whole tree elsewhere — see kohaku-surface.ts), so only ctrl's remoteActive can move
  // this decision after the initial call.
  const syncBaseAttach = (): void => {
    const enabled = !(serverSide && ctrl.getSnapshot().remoteActive);
    if (enabled === baseEnabled) return;
    baseEnabled = enabled;
    baseDetach();
    baseDetach = rt.controller.attach(
      node,
      rt.spec,
      (state) => {
        base = state;
        rerender();
      },
      { enabled },
    );
  };

  // ctrl.subscribe is registered before ctrl.start() so that a synchronous initial refetch (when
  // sortBy/pageSize is declared) notifies here too, keeping base's (dis)attachment and the very first
  // paint's remote/base choice consistent from the start (see the "single initial fetch" parity test).
  const unsubCtrl = ctrl.subscribe(() => {
    syncBaseAttach();
    rerender();
  });
  const stopCtrl = ctrl.start();

  // Keep the controller's ref following data.bind + $state (mirrors renderer-react's
  // useSpreadsheetRemote effect: see use-spreadsheet-remote.ts) so sort/page refetches target the
  // node's currently effective ref, not the raw ref this part was constructed with. setRef itself
  // no-ops when the ref is unchanged, so calling it eagerly here and on every state change is cheap.
  const computeEffectiveRef = (): string | undefined =>
    node.data != null ? resolveBoundRef(node.data, rt.store.values) : undefined;
  ctrl.setRef(computeEffectiveRef());
  const unsubState = rt.store.subscribe(() => ctrl.setRef(computeEffectiveRef()));

  // Idempotent: a no-op if ctrl.start()'s own synchronous refetch already ran syncBaseAttach above
  // (serverSide + sortBy/pageSize declared); otherwise this is what performs the initial base attach
  // (serverSide=false, or serverSide=true but inactive).
  syncBaseAttach();

  return () => {
    baseDetach();
    unsubCtrl();
    stopCtrl();
    unsubState();
  };
};

interface RenderOpts {
  serverSide: boolean;
  sort: SortState | undefined;
  cursor: string | undefined;
  rowClickable: boolean;
  editable: boolean;
  /** The (memoized) local-view rows — see rowsCache in the builder above. Ignored when state is not ready. */
  rows: JsonObject[];
  copy: RowsWorkingCopy | undefined;
  editing: SpreadsheetCellEdit | undefined;
  colors: SpreadsheetTokens;
  onToggleSort: (colKey: string) => void;
  onFirstPage: () => void;
  onNextPage: (next: string) => void;
  onStartEdit: (rowIndex: number, col: TabularColumn) => void;
  onCommit: (input: HTMLInputElement, rowIndex: number, col: TabularColumn) => void;
  onCancel: () => void;
}

function renderTable(rt: RenderRuntime, node: ComponentNode, state: BoundData, opts: RenderOpts): Node {
  if (state.status !== "ready") {
    // dataStateNotice renders nothing for "idle" (no display element yet), but swap() requires a real
    // Node — fall back to an empty placeholder rather than passing null to replaceWith. Reachable for a
    // serverSide spreadsheet that starts inactive (no declaredSort/pageSize/interaction yet): the remote
    // controller's own start()/setRef can notify while the base (BoundDataController) is still idle,
    // ahead of its own first onChange.
    return dataStateNotice(rt, state) ?? document.createComment(`kohaku:idle:${node.id}`);
  }
  const data = state.data;
  const { border, headerBg, accent, muted } = opts.colors;
  const sizing = rt.sizing;

  const columns = resolveColumns(node, data);
  const displayRows = effectiveRows(opts.rows, opts.copy);

  const wrapper = el("div", { "data-kohaku": node.id }, { width: "100%", overflowX: "auto" });
  const table = el("table", {}, chartTableStyle(sizing));

  // ---- thead ----
  const thead = el("thead");
  const headRow = el("tr");
  for (const col of columns) {
    // aria-sort / label / arrow are all derived by renderer-core's describeSortHeader (single source of truth
    // shared with renderer-react).
    const h = describeSortHeader(col, opts.sort);
    const th = el("th", {}, spreadsheetThStyle({ headerBg, border, muted }, sizing));
    if (h.ariaSort != null) th.setAttribute("aria-sort", h.ariaSort);
    const btn = el("button", { type: "button" }, spreadsheetSortButtonStyle({ numeric: h.numeric }, sizing));
    btn.appendChild(text(h.label));
    if (h.arrow != null) {
      const arrow = el("span", { "aria-hidden": "true" }, { color: accent });
      arrow.appendChild(text(h.arrow));
      btn.appendChild(arrow);
    }
    btn.addEventListener("click", () => opts.onToggleSort(col.key));
    th.appendChild(btn);
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  // ---- tbody ----
  const tbody = el("tbody");
  // editable drops role/tabIndex/keydown entirely (an editable cell's own button/input is already
  // interactive; nesting that inside a role="button" row trips axe's nested-interactive rule) —
  // onClick stays wired for rowClick, but each cell's own button/input stops propagation so an edit
  // interaction never also fires rowClick.
  const rowKeyboardOperable = !opts.editable && opts.rowClickable;
  displayRows.forEach((row, rowIndex) => {
    const tr = el(
      "tr",
      {},
      { cursor: opts.rowClickable ? "pointer" : "default", borderBottom: `1px solid ${border}` },
    );
    if (opts.rowClickable) {
      tr.addEventListener("click", () => rt.emit(node, "rowClick", { row }, null));
    }
    if (rowKeyboardOperable) {
      tr.setAttribute("role", "button");
      tr.tabIndex = 0;
      tr.addEventListener("keydown", (e) => {
        if (isActivationKey(e.key)) {
          if (e.key === " ") e.preventDefault();
          rt.emit(node, "rowClick", { row }, null);
        }
      });
    }
    for (const col of columns) {
      const numeric = col.type === "number";
      if (!opts.editable) {
        const td = el("td", {}, spreadsheetTdStyle({ numeric }, sizing));
        td.appendChild(text(formatCell(row[col.key], col, rt.locale)));
        tr.appendChild(td);
        continue;
      }
      const td = el("td", {}, spreadsheetTdStyle({ numeric }, sizing));
      const editingHere =
        opts.editing?.rowIndex === rowIndex && opts.editing.column === col.key ? opts.editing : undefined;
      if (editingHere != null) {
        const input = el(
          "input",
          {
            type: "text",
            "aria-label": rt.messages.spreadsheetEditCell(col.label ?? col.key),
            ...(editingHere.invalid ? { "aria-invalid": "true" } : {}),
          },
          spreadsheetCellEditInputStyle({ border }, { numeric }, sizing),
        ) as HTMLInputElement;
        input.value = cellDraft(row[col.key], col);
        input.addEventListener("click", (e) => e.stopPropagation());
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            opts.onCommit(input, rowIndex, col);
          } else if (e.key === "Escape") {
            e.preventDefault();
            opts.onCancel();
          }
        });
        input.addEventListener("blur", () => opts.onCommit(input, rowIndex, col));
        td.appendChild(input);
      } else {
        const btn = el(
          "button",
          { type: "button", "aria-label": rt.messages.spreadsheetEditCell(col.label ?? col.key) },
          spreadsheetCellEditButtonStyle({ numeric }),
        );
        btn.appendChild(text(formatCell(row[col.key], col, rt.locale)));
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          opts.onStartEdit(rowIndex, col);
        });
        td.appendChild(btn);
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrapper.appendChild(table);

  // ---- footer / pager ----
  appendFooter(rt, wrapper, data, displayRows.length, opts);
  return wrapper;
}

function appendFooter(
  rt: RenderRuntime,
  wrapper: HTMLElement,
  data: TabularData,
  shown: number,
  opts: RenderOpts,
): void {
  const { border, accent, muted } = opts.colors;
  const sizing = rt.sizing;
  if (opts.serverSide) {
    const bar = el("div", {}, spreadsheetFooterBarStyle({ muted }, sizing));
    if (data.total != null) {
      const span = el("span");
      span.appendChild(text(rt.messages.spreadsheetTotal(data.total.toLocaleString(rt.locale), shown)));
      bar.appendChild(span);
    }
    if (opts.cursor != null) {
      const b = pagerButton(rt.messages.spreadsheetFirstPage, { border, accent }, sizing);
      b.addEventListener("click", () => opts.onFirstPage());
      bar.appendChild(b);
    }
    if (data.nextCursor != null) {
      const next = data.nextCursor;
      const b = pagerButton(rt.messages.spreadsheetNextPage, { border, accent }, sizing);
      b.addEventListener("click", () => opts.onNextPage(next));
      bar.appendChild(b);
    }
    wrapper.appendChild(bar);
  } else {
    const localTotal = localFooterTotal(data, shown);
    if (localTotal != null) {
      const div = el("div", {}, spreadsheetFooterTotalStyle({ muted }, sizing));
      div.appendChild(text(rt.messages.spreadsheetTotal(localTotal.toLocaleString(rt.locale), shown)));
      wrapper.appendChild(div);
    }
  }
}

function pagerButton(
  label: string,
  tokens: Pick<SpreadsheetTokens, "border" | "accent">,
  sizing: SizingTokens,
): HTMLElement {
  const b = el("button", { type: "button" }, spreadsheetPagerButtonStyle(tokens, sizing));
  b.appendChild(text(label));
  return b;
}

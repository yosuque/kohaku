import {
  applyLocalView,
  type BoundData,
  createSpreadsheetRemoteController,
  describeSortHeader,
  formatCell,
  hasDeclaredEvent,
  isActivationKey,
  resolveColumns,
  type SortState,
  type SpreadsheetTokens,
  spreadsheetFooterBarStyle,
  spreadsheetFooterTotalStyle,
  spreadsheetPagerButtonStyle,
  spreadsheetSortButtonStyle,
  spreadsheetTdStyle,
  spreadsheetThStyle,
} from "@kohaku-ui/renderer-core";
import { type ComponentNode, resolveBoundRef, type TabularData } from "@kohaku-ui/spec-core";
import { el, text } from "../dom.js";
import type { PartBuilder, RenderRuntime } from "../types.js";
import { dataStateNotice, tokenStr } from "./kit.js";

/**
 * presentSpreadsheet — a table (same behavior as renderer-react's PresentSpreadsheet).
 * In-column sorting is an "operation that does not change intent" so it uses local state; a row click is an "operation
 * that changes intent" so it goes upstream via a Spec-declared event. In serverSide (opt-in), sorting/paging is done via
 * binding.resolve refetches. Current sort is indicated by aria-sort / ▲▼.
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
  const rowClickable = hasDeclaredEvent(rt.spec, node.id, "rowClick");

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

  const rerender = (): void => {
    const snap = ctrl.getSnapshot();
    swap(
      renderTable(rt, node, displayed(), {
        serverSide,
        sort: snap.sort,
        cursor: snap.cursor,
        pageSize,
        rowClickable,
        colors: { border, headerBg, accent, muted },
        onToggleSort: (colKey) => ctrl.toggleSort(colKey),
        onFirstPage: () => ctrl.goFirstPage(),
        onNextPage: (next) => ctrl.goNextPage(next),
      }),
    );
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
  pageSize: number | undefined;
  rowClickable: boolean;
  colors: SpreadsheetTokens;
  onToggleSort: (colKey: string) => void;
  onFirstPage: () => void;
  onNextPage: (next: string) => void;
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
  const { border, headerBg, accent } = opts.colors;

  const columns = resolveColumns(node, data);
  const rows = opts.serverSide ? data.rows : applyLocalView(data.rows, opts.sort, opts.pageSize, rt.locale);

  const wrapper = el("div", { "data-kohaku": node.id }, { width: "100%", overflowX: "auto" });
  const table = el("table", {}, { width: "100%", borderCollapse: "collapse", fontSize: 13.5 });

  // ---- thead ----
  const thead = el("thead");
  const headRow = el("tr");
  for (const col of columns) {
    // aria-sort / label / arrow are all derived by renderer-core's describeSortHeader (single source of truth
    // shared with renderer-react).
    const h = describeSortHeader(col, opts.sort);
    const th = el("th", {}, spreadsheetThStyle({ headerBg, border }));
    if (h.ariaSort != null) th.setAttribute("aria-sort", h.ariaSort);
    const btn = el("button", { type: "button" }, spreadsheetSortButtonStyle({ numeric: h.numeric }));
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
  for (const row of rows) {
    const tr = el(
      "tr",
      {},
      { cursor: opts.rowClickable ? "pointer" : "default", borderBottom: `1px solid ${border}` },
    );
    if (opts.rowClickable) {
      tr.setAttribute("role", "button");
      tr.tabIndex = 0;
      tr.addEventListener("click", () => rt.emit(node, "rowClick", { row }, null));
      tr.addEventListener("keydown", (e) => {
        if (isActivationKey(e.key)) {
          if (e.key === " ") e.preventDefault();
          rt.emit(node, "rowClick", { row }, null);
        }
      });
    }
    for (const col of columns) {
      const td = el("td", {}, spreadsheetTdStyle({ numeric: col.type === "number" }));
      td.appendChild(text(formatCell(row[col.key], col, rt.locale)));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrapper.appendChild(table);

  // ---- footer / pager ----
  appendFooter(rt, wrapper, data, rows.length, opts);
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
  if (opts.serverSide) {
    const bar = el("div", {}, spreadsheetFooterBarStyle({ muted }));
    if (data.total != null) {
      const span = el("span");
      span.appendChild(text(rt.messages.spreadsheetTotal(data.total.toLocaleString(rt.locale), shown)));
      bar.appendChild(span);
    }
    if (opts.cursor != null) {
      const b = pagerButton(rt.messages.spreadsheetFirstPage, { border, accent });
      b.addEventListener("click", () => opts.onFirstPage());
      bar.appendChild(b);
    }
    if (data.nextCursor != null) {
      const next = data.nextCursor;
      const b = pagerButton(rt.messages.spreadsheetNextPage, { border, accent });
      b.addEventListener("click", () => opts.onNextPage(next));
      bar.appendChild(b);
    }
    wrapper.appendChild(bar);
  } else if (data.total != null && data.total > shown) {
    const div = el("div", {}, spreadsheetFooterTotalStyle({ muted }));
    div.appendChild(text(rt.messages.spreadsheetTotal(data.total.toLocaleString(rt.locale), shown)));
    wrapper.appendChild(div);
  }
}

function pagerButton(label: string, tokens: Pick<SpreadsheetTokens, "border" | "accent">): HTMLElement {
  const b = el("button", { type: "button" }, spreadsheetPagerButtonStyle(tokens));
  b.appendChild(text(label));
  return b;
}

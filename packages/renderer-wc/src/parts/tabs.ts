import {
  describeTab,
  nextTabIndex,
  resolveTabs,
  type TabMeta,
  tabButtonStyle,
} from "@kohaku-ui/renderer-core";
import { el, noop, setStyle, text } from "../dom.js";
import type { PartBuilder, RenderRuntime, Teardown } from "../types.js";
import { tokenStr } from "./kit.js";

/**
 * layout.tabs — a tab container (same as renderer-react's LayoutTabs). The source of truth for selection is $state.<stateKey>.
 * Tab switching calls store.set directly as an in-component local operation (does not require an events declaration). If a "select"
 * declaration exists, it additionally emits. The panel builds only the selected layout.tab; unselected ones are not built (lazy loading).
 * a11y: role=tablist/tab/tabpanel + aria-selected + arrow keys to move between tabs.
 */
export const layoutTabs: PartBuilder = (rt, parent, node, row) => {
  const accent = tokenStr(rt, "color.primary");
  const border = tokenStr(rt, "color.border");
  const muted = tokenStr(rt, "color.muted");

  const stateKey = String(node.props["stateKey"] ?? "");
  const childIds = node.children ?? [];
  const tabs: TabMeta[] = resolveTabs(childIds, (id) => rt.byId.get(id));

  if (tabs.length === 0) {
    const empty = el("div", { "data-kohaku": node.id });
    parent.appendChild(empty);
    return () => empty.remove();
  }

  const container = el(
    "div",
    { "data-kohaku": node.id },
    {
      display: "flex",
      flexDirection: "column",
      gap: rt.sizing.space3,
      width: "100%",
    },
  );
  const tablist = el(
    "div",
    { role: "tablist" },
    {
      display: "flex",
      gap: rt.sizing.space1,
      borderBottom: `1px solid ${border}`,
    },
  );
  const panel = el("div", { role: "tabpanel" });
  container.append(tablist, panel);
  parent.appendChild(container);

  const currentValue = (): unknown => rt.store.get(stateKey);
  const selectedOf = (): TabMeta => tabs.find((t) => String(t.value) === String(currentValue())) ?? tabs[0]!;

  const buttons: HTMLButtonElement[] = [];

  const select = (tab: TabMeta): void => {
    rt.store.set(stateKey, tab.value);
    // If "select" is declared, notify upstream (if undeclared, it is discarded inside rt.emit).
    rt.emit(node, "select", { value: tab.value }, row);
  };

  const onKeyDown = (e: KeyboardEvent, pos: number): void => {
    const next = nextTabIndex(e.key, pos, tabs.length);
    if (next == null) return;
    e.preventDefault();
    select(tabs[next]!);
    buttons[next]?.focus();
  };

  tabs.forEach((tab, pos) => {
    const btn = el("button", {
      role: "tab",
      type: "button",
      id: describeTab(node.id, tab.value).tabId,
    }) as HTMLButtonElement;
    btn.appendChild(text(tab.label));
    btn.addEventListener("click", () => select(tab));
    btn.addEventListener("keydown", (e) => onKeyDown(e, pos));
    buttons.push(btn);
    tablist.appendChild(btn);
  });

  // Reflect the appearance/aria and panel content according to the selection. The panel builds only the selected tab's child.
  let panelTeardown: Teardown = noop;
  let appliedValue: string | null = null;
  let built = false;

  const applySelection = (): void => {
    const selected = selectedOf();
    // On a state change where the selected value is unchanged (originating from another part), do not rebuild the panel (preserves the lazy-load state).
    if (built && appliedValue === selected.value) return;
    built = true;
    appliedValue = selected.value;
    const selectedIds = describeTab(node.id, selected.value);

    tabs.forEach((tab, pos) => {
      const btn = buttons[pos]!;
      const isSelected = tab.value === selected.value;
      btn.setAttribute("aria-selected", String(isSelected));
      btn.setAttribute("aria-controls", selectedIds.panelId);
      btn.tabIndex = isSelected ? 0 : -1;
      setStyle(btn, tabButtonStyle({ accent, muted }, { active: isSelected }, rt.sizing));
    });

    panel.setAttribute("id", selectedIds.panelId);
    panel.setAttribute("aria-labelledby", selectedIds.tabId);
    panelTeardown();
    panel.replaceChildren();
    panelTeardown = rt.mountNode(panel, selected.id, row);
  };

  applySelection();
  const unsub = rt.store.subscribe(() => applySelection());

  return () => {
    unsub();
    panelTeardown();
    container.remove();
  };
};

/** layout.tab — a single tab's panel (same as renderer-react's LayoutTab). A simple container. */
export const layoutTab: PartBuilder = (rt: RenderRuntime, parent, node, row) => {
  const container = el(
    "div",
    { "data-kohaku": node.id },
    {
      display: "flex",
      flexDirection: "column",
      gap: rt.sizing.space4,
      width: "100%",
    },
  );
  parent.appendChild(container);
  return rt.mountChildren(container, node.children, row);
};

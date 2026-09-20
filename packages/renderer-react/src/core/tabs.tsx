import {
  describeTab,
  nextTabIndex,
  resolveTabs,
  type TabMeta,
  tabButtonStyle,
} from "@kohaku-ui/renderer-core";
import { Children, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useRef } from "react";
import { type ImplProps, useEmitEvent, useSizing, useSpec, useToken } from "../context.js";
import { useSpecState } from "../spec-state.js";

/**
 * Tab container (layout.tabs, kohaku >= 0.2). The truth of selection state is $state.<stateKey>.
 * Tab switching directly calls useSpecState().set as an "in-component local operation" (does not require an events declaration
 * — prevents the accident of a missing declaration killing the tabs). If "select" is declared, additionally emit.
 * The panel renders only the selected layout.tab, and unselected panels are unmounted (lazy loading).
 * a11y: role=tablist/tab/tabpanel + aria-selected + move tabs with the left/right arrow keys.
 */
export function LayoutTabs({ node, children }: ImplProps): ReactNode {
  const spec = useSpec();
  const stateState = useSpecState();
  const emit = useEmitEvent(node);
  const sizing = useSizing();
  const accent = String(useToken("color.primary"));
  const border = String(useToken("color.border"));
  const muted = String(useToken("color.muted"));
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const stateKey = String(node.props["stateKey"] ?? "");
  const childIds = node.children ?? [];
  const childArray = Children.toArray(children);

  // Look up the child layout.tab's value/label from the Spec (also retaining its position within the children array).
  const tabs: TabMeta[] = resolveTabs(childIds, (id) => spec.components.find((x) => x.id === id));

  if (tabs.length === 0) return <div data-kohaku={node.id} />;

  // If state[stateKey] is undefined, treat the first tab as selected (the initial value is normally defined in spec.state).
  const currentValue = stateState.get(stateKey);
  const selected = tabs.find((t) => String(t.value) === String(currentValue)) ?? tabs[0]!;

  const select = (tab: TabMeta): void => {
    stateState.set(stateKey, tab.value);
    // If "select" is declared, notify upstream (if undeclared, it is discarded on the useEmitEvent side).
    emit("select", { value: tab.value });
  };

  const onKeyDown = (e: ReactKeyboardEvent, pos: number): void => {
    const next = nextTabIndex(e.key, pos, tabs.length);
    if (next == null) return;
    e.preventDefault();
    select(tabs[next]!);
    btnRefs.current[next]?.focus();
  };

  const selectedIds = describeTab(node.id, selected.value);

  return (
    <div
      data-kohaku={node.id}
      style={{ display: "flex", flexDirection: "column", gap: sizing.space3, width: "100%" }}
    >
      <div
        role="tablist"
        style={{ display: "flex", gap: sizing.space1, borderBottom: `1px solid ${border}` }}
      >
        {tabs.map((tab, pos) => {
          const isSelected = tab.value === selected.value;
          const { tabId } = describeTab(node.id, tab.value);
          return (
            <button
              key={tab.value}
              ref={(el) => {
                btnRefs.current[pos] = el;
              }}
              role="tab"
              type="button"
              id={tabId}
              aria-selected={isSelected}
              aria-controls={selectedIds.panelId}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => select(tab)}
              onKeyDown={(e) => onKeyDown(e, pos)}
              style={tabButtonStyle({ accent, muted }, { active: isSelected }, sizing)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={selectedIds.panelId} aria-labelledby={selectedIds.tabId}>
        {childArray[selected.index]}
      </div>
    </div>
  );
}

/**
 * A single tab's panel (layout.tab). The parent layout.tabs decides which to show, so this is a simple container.
 * It is rendered only while selected (unselected is unmounted).
 */
export function LayoutTab({ node, children }: ImplProps): ReactNode {
  const sizing = useSizing();
  return (
    <div
      data-kohaku={node.id}
      style={{ display: "flex", flexDirection: "column", gap: sizing.space4, width: "100%" }}
    >
      {children}
    </div>
  );
}

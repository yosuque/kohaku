import type { ComponentNode } from "@kohaku-ui/spec-core";
import { DEFAULT_SIZING, type SizingTokens } from "../theme.js";

/** A single tab's resolved metadata (derived from its layout.tab child node). */
export interface TabMeta {
  /** The layout.tab child node's own id (WC mounts the panel directly by this id). */
  id: string;
  /** Position within the tabs container's children array (React uses this to index Children.toArray). */
  index: number;
  value: string;
  label: string;
}

/**
 * Resolves the layout.tab children of a layout.tabs container (shared by both renderers). `lookup` resolves a
 * component id to its ComponentNode (React: `spec.components.find`; WC: `rt.byId.get`). Children that are missing
 * or not of type "layout.tab" are filtered out.
 */
export function resolveTabs(
  childIds: string[],
  lookup: (id: string) => ComponentNode | undefined,
): TabMeta[] {
  return childIds
    .map((id, index): TabMeta | null => {
      const c = lookup(id);
      if (c == null || c.type !== "layout.tab") return null;
      return { id, index, value: String(c.props["value"] ?? ""), label: String(c.props["label"] ?? "") };
    })
    .filter((t): t is TabMeta => t != null);
}

/**
 * Computes the next tab index for arrow-key navigation: ArrowRight/ArrowDown moves forward (wrapping),
 * ArrowLeft/ArrowUp moves backward (wrapping). Returns null for any other key, meaning the caller should neither
 * preventDefault nor move selection.
 */
export function nextTabIndex(key: string, pos: number, len: number): number | null {
  if (key === "ArrowRight" || key === "ArrowDown") return (pos + 1) % len;
  if (key === "ArrowLeft" || key === "ArrowUp") return (pos - 1 + len) % len;
  return null;
}

/** The id pair a tab/panel share: the tab button's id and the panel's id. */
export interface TabIds {
  tabId: string;
  panelId: string;
}

/** The id scheme for a tab button and its panel: `${nodeId}-tab-${value}` / `${nodeId}-panel-${value}`. */
export function describeTab(nodeId: string, value: string): TabIds {
  return { tabId: `${nodeId}-tab-${value}`, panelId: `${nodeId}-panel-${value}` };
}

/** Color tokens consumed by tabButtonStyle. */
export interface TabButtonTokens {
  accent: string;
  muted: string;
}

/** A tab button's look (the underline + color/weight swap between selected and unselected). */
export function tabButtonStyle(
  tokens: TabButtonTokens,
  options: { active: boolean },
  sizing: SizingTokens = DEFAULT_SIZING,
) {
  const { active } = options;
  return {
    background: "none",
    border: "none",
    borderBottom: `2px solid ${active ? tokens.accent : "transparent"}`,
    color: active ? tokens.accent : tokens.muted,
    fontWeight: active ? 700 : 500,
    fontSize: sizing.fontMd,
    padding: `${sizing.space2} ${sizing.space3}`,
    marginBottom: -1,
    cursor: "pointer",
  } as const;
}

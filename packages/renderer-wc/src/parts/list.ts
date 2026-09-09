import {
  type BoundData,
  GAP,
  HARD_ROW_CAP,
  hasDeclaredEvent,
  isActivationKey,
} from "@kohaku-ui/renderer-core";
import type { ComponentNode, JsonObject } from "@kohaku-ui/spec-core";
import { el, noop, text } from "../dom.js";
import type { PartBuilder, RenderRuntime, Teardown } from "../types.js";
import { dataStateNotice, mountBoundPart, tokenStr } from "./kit.js";

/**
 * presentList — applies the children template to each row of the data reference and lays them out (same as renderer-react's PresentList).
 * A row's props "$row.<column>" are substituted in the row context (rt.mountNode applies resolveRowProps), and if an itemClick
 * declaration exists, each row is made interactive (the context row is in runtime.row).
 */
export const presentList: PartBuilder = (rt, parent, node) => {
  const itemClickable = hasDeclaredEvent(rt.spec, node.id, "itemClick");
  const gap = GAP[(node.props["gap"] as string) ?? "sm"] ?? 8;
  const maxItems = node.props["maxItems"] as number | undefined;
  const emptyText = String(node.props["emptyText"] ?? "(No data)");

  return mountBoundPart(rt, parent, node, (state: BoundData) => {
    if (state.status !== "ready") return { el: dataStateNotice(rt, state)! };
    return renderList(rt, node, state.data.rows, { itemClickable, gap, maxItems, emptyText });
  });
};

function renderList(
  rt: RenderRuntime,
  node: ComponentNode,
  allRows: JsonObject[],
  opts: { itemClickable: boolean; gap: number; maxItems: number | undefined; emptyText: string },
): { el: HTMLElement; teardown: Teardown } {
  const limit = Math.min(opts.maxItems ?? HARD_ROW_CAP, HARD_ROW_CAP);
  const rows = allRows.slice(0, limit);

  if (rows.length === 0) {
    const empty = el(
      "div",
      { "data-kohaku": node.id },
      { color: tokenStr(rt, "color.muted"), fontSize: 13, padding: "8px 2px" },
    );
    empty.appendChild(text(opts.emptyText));
    return { el: empty, teardown: noop };
  }

  const container = el(
    "div",
    { "data-kohaku": node.id, role: "list" },
    {
      display: "flex",
      flexDirection: "column",
      gap: opts.gap,
      width: "100%",
    },
  );

  const teardowns: Teardown[] = [];
  rows.forEach((row) => {
    const item = el("div", { role: "listitem" }, { cursor: opts.itemClickable ? "pointer" : "default" });
    if (opts.itemClickable) {
      item.tabIndex = 0;
      item.addEventListener("click", () => rt.emit(node, "itemClick", { row }, row));
      item.addEventListener("keydown", (e) => {
        if (isActivationKey(e.key)) {
          if (e.key === " ") e.preventDefault();
          rt.emit(node, "itemClick", { row }, row);
        }
      });
    }
    // Build the children template in the row context ($row substitution and row-context events are resolved by rt.mountChildren).
    teardowns.push(rt.mountChildren(item, node.children, row));
    container.appendChild(item);
  });

  return {
    el: container,
    teardown: () => {
      for (const t of teardowns) t();
    },
  };
}

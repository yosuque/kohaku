import { GAP } from "@kohaku-ui/renderer-core";
import { el } from "../dom.js";
import type { PartBuilder } from "../types.js";

/** layout.stack — a vertical/horizontal stack (same markup as renderer-react's LayoutStack). */
export const layoutStack: PartBuilder = (rt, parent, node, row) => {
  const direction = (node.props["direction"] as string) ?? "vertical";
  const gap = GAP[(node.props["gap"] as string) ?? "md"] ?? 16;
  const container = el(
    "div",
    { "data-kohaku": node.id },
    {
      display: "flex",
      flexDirection: direction === "horizontal" ? "row" : "column",
      gap,
      width: "100%",
    },
  );
  parent.appendChild(container);
  return rt.mountChildren(container, node.children, row);
};

/** layout.grid — an equal-width grid (same markup as renderer-react's LayoutGrid). */
export const layoutGrid: PartBuilder = (rt, parent, node, row) => {
  const columns = (node.props["columns"] as number) ?? 2;
  const gap = GAP[(node.props["gap"] as string) ?? "md"] ?? 16;
  const container = el(
    "div",
    { "data-kohaku": node.id },
    {
      display: "grid",
      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
      gap,
      width: "100%",
    },
  );
  parent.appendChild(container);
  return rt.mountChildren(container, node.children, row);
};

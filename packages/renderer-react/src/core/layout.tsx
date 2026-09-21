import { gapFor } from "@kohaku-ui/renderer-core";
import type { ReactNode } from "react";
import { type ImplProps, useSizing } from "../context.js";

export function LayoutStack({ node, children }: ImplProps): ReactNode {
  const direction = (node.props["direction"] as string) ?? "vertical";
  const sizing = useSizing();
  const gap = gapFor(sizing, node.props["gap"] as string | undefined);
  return (
    <div
      data-kohaku={node.id}
      style={{
        display: "flex",
        flexDirection: direction === "horizontal" ? "row" : "column",
        gap,
        width: "100%",
      }}
    >
      {children}
    </div>
  );
}

export function LayoutGrid({ node, children }: ImplProps): ReactNode {
  const columns = (node.props["columns"] as number) ?? 2;
  const sizing = useSizing();
  const gap = gapFor(sizing, node.props["gap"] as string | undefined);
  return (
    <div
      data-kohaku={node.id}
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gap,
        width: "100%",
      }}
    >
      {children}
    </div>
  );
}

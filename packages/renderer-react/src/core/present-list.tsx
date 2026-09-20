import {
  gapFor,
  HARD_ROW_CAP,
  hasDeclaredEvent,
  isActivationKey,
  listEmptyStyle,
  rowKey,
} from "@kohaku-ui/renderer-core";
import type { ReactNode } from "react";
import { type ImplProps, useEmitEvent, useSizing, useSpec, useToken } from "../context.js";
import { RowProvider } from "../spec-state.js";
import { useBoundData } from "../use-bound-data.js";
import { DataStateNotice } from "./data-states.js";

/**
 * A list (presentList) that applies a children template to each row of a data reference and lays them out.
 * It renders the same children element tree once per row, wrapped in RowProvider (legal because React elements are descriptions).
 * The in-row props "$row.<column name>" are substituted by NodeView with that row's value (resolveRowProps).
 * If itemClick is declared, make each row an operable element (the contextual row is in runtime.row).
 */
export function PresentList({ node, children }: ImplProps): ReactNode {
  const state = useBoundData(node);
  const emit = useEmitEvent(node);
  const spec = useSpec();
  const sizing = useSizing();
  const muted = String(useToken("color.muted"));

  // Unset gap defaulted to "sm" (8px) before tokenization; gapFor's own default is "md" (16px), so the
  // "sm" default is preserved explicitly here to keep the existing look unchanged (see task-13-report.md).
  const gap = gapFor(sizing, (node.props["gap"] as string | undefined) ?? "sm");
  const maxItems = node.props["maxItems"] as number | undefined;
  const emptyText = String(node.props["emptyText"] ?? "(No data)");
  const itemClickable = hasDeclaredEvent(spec, node.id, "itemClick");

  if (state.status !== "ready") return <DataStateNotice state={state} />;

  const limit = Math.min(maxItems ?? HARD_ROW_CAP, HARD_ROW_CAP);
  const rows = state.data.rows.slice(0, limit);

  if (rows.length === 0) {
    return (
      <div data-kohaku={node.id} style={listEmptyStyle(muted, sizing)}>
        {emptyText}
      </div>
    );
  }

  return (
    // div+role="list"/"listitem" (not <ul>/<li>) mirrors renderer-wc/src/parts/list.ts exactly, which the
    // React/WC DOM-parity corpus (packages/renderer-wc/test/parity) relies on; switching to semantic
    // elements here without an equivalent, pixel-matched change on the WC side would break that parity.
    // biome-ignore lint/a11y/useSemanticElements: deliberate div+role to mirror renderer-wc's DOM for parity (see comment above).
    <div
      data-kohaku={node.id}
      role="list"
      style={{ display: "flex", flexDirection: "column", gap, width: "100%" }}
    >
      {rows.map((row, i) => (
        // Wrap each row in RowProvider so the inner NodeView can resolve $row substitution and row-context events.
        // The key weaves in the row content rather than a pure index (rowKey). This prevents local state within the
        // template (form input etc.) from sticking to a different row on insertion/reordering.
        <RowProvider key={rowKey(row, state.data.columns, i)} row={row}>
          {/* biome-ignore lint/a11y/useSemanticElements: deliberate div+role to mirror renderer-wc's DOM for parity (see comment on the container above). */}
          <div
            role="listitem"
            onClick={itemClickable ? () => emit("itemClick", { row }) : undefined}
            tabIndex={itemClickable ? 0 : undefined}
            onKeyDown={
              itemClickable
                ? (e) => {
                    if (isActivationKey(e.key)) {
                      if (e.key === " ") e.preventDefault();
                      emit("itemClick", { row });
                    }
                  }
                : undefined
            }
            style={{ cursor: itemClickable ? "pointer" : "default" }}
          >
            {children}
          </div>
        </RowProvider>
      ))}
    </div>
  );
}

import { resolveDataStateView } from "@kohaku-ui/renderer-core";
import type { ReactNode } from "react";
import { useMessages, useRenderer } from "../context.js";
import type { BoundData } from "../use-bound-data.js";

/** Common display for loading / stale / error. Returns null only when ready / idle. */
export function DataStateNotice({ state }: { state: BoundData }): ReactNode {
  const messages = useMessages();
  const { theme } = useRenderer();
  const view = resolveDataStateView(state, theme, messages);
  if (view == null) return null;
  return (
    <div
      role={view.role}
      style={{
        background: view.bg,
        color: view.fg,
        borderRadius: 6,
        padding: "10px 12px",
        fontSize: 13,
      }}
    >
      {view.text}
    </div>
  );
}

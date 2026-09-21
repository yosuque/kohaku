import { dataStateNoticeStyle, resolveDataStateView } from "@kohaku-ui/renderer-core";
import type { ReactNode } from "react";
import { useMessages, useRenderer, useSizing } from "../context.js";
import type { BoundData } from "../use-bound-data.js";

/** Common display for loading / stale / error. Returns null only when ready / idle. */
export function DataStateNotice({ state }: { state: BoundData }): ReactNode {
  const messages = useMessages();
  const { theme } = useRenderer();
  const sizing = useSizing();
  const view = resolveDataStateView(state, theme, messages);
  if (view == null) return null;
  return (
    <div role={view.role} style={dataStateNoticeStyle({ bg: view.bg, fg: view.fg }, sizing)}>
      {view.text}
    </div>
  );
}

import type { ThemeTokens } from "@kohaku-ui/spec-core";
import type { RendererMessages } from "../messages.js";
import type { BoundData } from "../stores/bound-data-controller.js";
import { resolveToken } from "../theme.js";

/** The resolved view for a non-ready BoundData notice (loading / stale / error). */
export interface DataStateView {
  role: "alert" | "status";
  bg: string;
  fg: string;
  text: string;
}

/**
 * Common view model for the loading/stale/error notice both renderers render for BoundData
 * (renderer-react's DataStateNotice / renderer-wc's dataStateNotice — the framework-free
 * source of truth). Returns null for ready/idle (nothing to show).
 */
export function resolveDataStateView(
  state: BoundData,
  theme: ThemeTokens,
  messages: Pick<RendererMessages, "dataLoading">,
): DataStateView | null {
  if (state.status === "ready" || state.status === "idle") return null;
  const styles = {
    loading: {
      bg: String(resolveToken(theme, "color.surface")),
      fg: String(resolveToken(theme, "color.muted")),
      text: messages.dataLoading,
    },
    stale: {
      bg: String(resolveToken(theme, "color.warning.surface")),
      fg: String(resolveToken(theme, "color.warning.text")),
      text: "",
    },
    error: {
      bg: String(resolveToken(theme, "color.negative.surface")),
      fg: String(resolveToken(theme, "color.negative.text")),
      text: "",
    },
  } as const;
  const s = styles[state.status];
  const message = "message" in state ? state.message : s.text;
  // error is an interruptive notification (role=alert); loading/stale are non-interruptive (role=status).
  const role = state.status === "error" ? "alert" : "status";
  return { role, bg: s.bg, fg: s.fg, text: message || s.text };
}

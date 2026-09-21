// framework-free / DOM-free. Inline style of the list part (presentList) shared by both renderers.
import type { SizingTokens } from "../theme.js";

/** The list's empty-state notice (React's PresentList and WC's presentList, e.g. "(No data)"). */
export function listEmptyStyle(muted: string, sizing: SizingTokens) {
  return { color: muted, fontSize: sizing.fontMd, padding: `${sizing.space2} 2px` } as const;
}

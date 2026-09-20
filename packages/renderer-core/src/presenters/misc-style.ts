// framework-free / DOM-free. Small inline styles shared by both renderers (loading, empty list, select, chart caption, render-failure note).

import type { SizingTokens } from "../theme.js";
import { formControlBaseStyle } from "./form.js";

export function loadingStyle(muted: string, sizing: SizingTokens) {
  return {
    display: "flex",
    alignItems: "center",
    gap: sizing.space2,
    color: muted,
    fontSize: sizing.fontMd,
    padding: `${sizing.space2} ${sizing.space3}`,
  } as const;
}
export function listEmptyStyle(muted: string, sizing: SizingTokens) {
  return { color: muted, fontSize: sizing.fontMd, padding: `${sizing.space2} 2px` } as const;
}
// The control-bar select (e.g. a spreadsheet/list filter) and a form's <select> deliberately share one chrome.
export function controlSelectStyle(border: string, sizing: SizingTokens) {
  return formControlBaseStyle(border, sizing);
}
export function chartCaptionStyle(sizing: SizingTokens) {
  return { fontSize: sizing.fontMd, fontWeight: 600, marginBottom: sizing.space2 } as const;
}
export function chartTableStyle(sizing: SizingTokens) {
  return { width: "100%", borderCollapse: "collapse", fontSize: sizing.fontMd } as const;
}
export function renderFailureNoticeStyle(color: string, sizing: SizingTokens) {
  return {
    border: `1px dashed ${color}`,
    color,
    borderRadius: sizing.radiusMd,
    padding: `${sizing.space2} ${sizing.space3}`,
    fontSize: sizing.fontSm,
  } as const;
}

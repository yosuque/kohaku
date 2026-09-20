// framework-free / DOM-free. Inline styles of the text part (text.markdown / text.heading) shared by both renderers.
import type { SizingTokens } from "../theme.js";

export function textHeadingStyle(color: string) {
  return { margin: 0, color, fontWeight: 650, lineHeight: 1.3 } as const;
}
export function textBodyStyle(color: string, sizing: SizingTokens) {
  return { color, fontSize: sizing.fontMd, lineHeight: 1.7 } as const;
}
export function textSubheadingStyle(sizing: SizingTokens) {
  return { margin: `${sizing.space2} 0 ${sizing.space1}`, fontWeight: 650 } as const;
}
export function textListStyle(sizing: SizingTokens) {
  return { margin: `${sizing.space1} 0`, paddingLeft: 20 } as const;
}
export function textPreStyle(surface: string, sizing: SizingTokens) {
  return {
    background: surface,
    borderRadius: sizing.radiusMd,
    padding: `${sizing.space2} ${sizing.space3}`,
    overflowX: "auto",
    fontSize: sizing.fontSm,
    fontFamily: sizing.fontMono,
  } as const;
}
export function textCodeStyle(surface: string, sizing: SizingTokens) {
  return {
    background: surface,
    borderRadius: sizing.radiusSm,
    padding: "1px 5px",
    fontSize: sizing.fontSm,
    fontFamily: sizing.fontMono,
  } as const;
}

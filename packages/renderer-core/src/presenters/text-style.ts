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
  return { margin: `${sizing.space1} 0`, paddingLeft: sizing.space5 } as const;
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
    // The 1px vertical inset has no close non-color token (space.1 is 4px, 4x too
    // large) and stays a deliberate literal, the same as renderer-core's other
    // hairline-scale values; only the 5px horizontal inset maps onto space.1.
    padding: `1px ${sizing.space1}`,
    fontSize: sizing.fontSm,
    fontFamily: sizing.fontMono,
  } as const;
}

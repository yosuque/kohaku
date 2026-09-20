import type { SizingTokens } from "../theme.js";

/**
 * Gap-token → pixel table shared by layout.stack and presentList in both renderers
 * (renderer-react's layout.tsx/present-list.tsx and renderer-wc's layout.ts/list.ts —
 * the framework-free source of truth).
 *
 * @deprecated Use `gapFor`, which reads the value from `SizingTokens` (the space scale)
 * instead of a hard-coded literal.
 */
export const GAP: Record<string, number> = { none: 0, sm: 8, md: 16, lg: 24 };

/** Layout gap keyword → the space scale (none=0, sm=space.2, md=space.4, lg=space.5; unknown/undefined = md). */
export function gapFor(sizing: SizingTokens, size: string | undefined): string {
  switch (size) {
    case "none":
      return "0";
    case "sm":
      return sizing.space2;
    case "lg":
      return sizing.space5;
    default:
      return sizing.space4;
  }
}

/** Absolute upper limit of rows presentList lays out (consistent with propsSchema's max). Large datasets are presentSpreadsheet's domain. */
export const HARD_ROW_CAP = 100;

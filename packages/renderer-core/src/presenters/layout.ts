import type { SizingTokens } from "../theme.js";

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

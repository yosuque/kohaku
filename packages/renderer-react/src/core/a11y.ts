import { visuallyHiddenStyle as coreVisuallyHiddenStyle } from "@kohaku-ui/renderer-core";
import type { CSSProperties } from "react";

/**
 * A style that is visually hidden but read by assistive tech (screen readers) (the clip pattern).
 * The "source of truth" for the value is the framework-free renderer-core definition. Here it is exposed
 * as React's CSSProperties type so that chart.tsx etc. can pass it directly as style={visuallyHiddenStyle}.
 */
export const visuallyHiddenStyle = coreVisuallyHiddenStyle as CSSProperties;

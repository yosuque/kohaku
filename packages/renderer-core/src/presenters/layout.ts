/**
 * Gap-token → pixel table shared by layout.stack and presentList in both renderers
 * (renderer-react's layout.tsx/present-list.tsx and renderer-wc's layout.ts/list.ts —
 * the framework-free source of truth).
 */
export const GAP: Record<string, number> = { none: 0, sm: 8, md: 16, lg: 24 };

/** Absolute upper limit of rows presentList lays out (consistent with propsSchema's max). Large datasets are presentSpreadsheet's domain. */
export const HARD_ROW_CAP = 100;

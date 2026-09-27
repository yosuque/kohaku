import { defineComponent } from "@kohaku-ui/registry";
import { z } from "zod";

/**
 * Single source of truth for the sales-domain product-specific parts (design.md #68). Before this package,
 * a part's {type, version} was written twice with no type link — once here (well, once in
 * apps/sample-api/src/catalog/contribution.ts, as it used to be) via defineComponent, and again as a bare
 * string literal in apps/sample-web/src/renderer-impls/index.ts's `.register()` calls — so a typo or
 * version drift between the two was undetected until runtime. sample-api (the catalog contribution),
 * sample-web (the React implementations, via `implement`) and sample-mcp's shared renderer (which reuses
 * sample-web's renderer-impls) all import these definitions instead of re-declaring type/version.
 */

export const salesKpiCard = defineComponent({
  type: "sales.kpiCard",
  version: "1.0.0",
  description:
    "Card display of a single KPI. The data reference is one row of {label, value, format, note} " +
    "(format: currency|percent|number). Use it to highlight a summary or attainment.",
  propsSchema: z.object({
    /** Specify only when you want to override the data row's label */
    label: z.string().optional(),
  }),
  capabilities: { events: [], data: "required", children: "none" },
  fallback: {
    type: "presentMarkdown",
    mapProps: () => ({ markdown: "(The KPI card is not available on this surface)" }),
  },
});

/**
 * The native pre-bundled implementation's contract for the promoted part sales.calendarHeatmap (see
 * SalesCalendarHeatmap.tsx's own doc comment for what "pre-bundled" means here). This is deliberately NOT
 * the ComponentDefinition placed in the catalog once the part is actually promoted — that one is rebuilt
 * per-artifact from the approved draft's paramsJsonSchema by sample-api's `promotedComponent()`
 * (apps/sample-api/src/intents/promoted.ts), which can vary request to request. This definition exists only
 * so the type + version the pre-bundled React implementation registers under — and the default draft
 * sample-web's promotion form prefills (apps/sample-web/src/pages/admin/promotion-defaults.ts) — come from
 * one place instead of two independently-written literals.
 */
export const salesCalendarHeatmap = defineComponent({
  type: "sales.calendarHeatmap",
  version: "1.0.0",
  description: "Native pre-bundled implementation contract for the promoted monthly calendar heatmap part.",
  propsSchema: z.object({
    /** Optional heading shown above the heatmap table. */
    title: z.string().optional(),
  }),
  capabilities: { events: [], data: "required", children: "none" },
});

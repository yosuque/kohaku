import type { PromotionDefaults } from "@kohaku-ui/admin-react";

/**
 * Sales-sample knowledge for the promotion approval form (kept out of the published console package):
 * the query paths sample-api's query source supports, and the prefill equivalent to the current trend
 * (paramsJsonSchema / queryTemplate). The 2026 default mirrors the server's demo "current period"
 * (apps/sample-api/src/intents/vocab.ts's DEMO_FISCAL_YEAR) — a literal because the web app has no dependency
 * on server code (AGENTS.md) and facet-views.json carries no default value.
 */
const TREND_PARAMS_SCHEMA = JSON.stringify(
  {
    type: "object",
    properties: {
      fiscalYear: { type: "integer", default: 2026 },
      region: { type: "string", enum: ["japan", "north_america", "europe", "apac"] },
    },
  },
  null,
  2,
);
const TREND_FIXED_PARAMS = JSON.stringify({ metric: "revenue", granularity: "month" }, null, 2);
const TREND_PARAM_MAP = JSON.stringify({ fiscalYear: "fy", region: "region" }, null, 2);

export const salesPromotionDefaults: PromotionDefaults = {
  queryPaths: ["", "trend", "summary", "records", "kpi", "targets"],
  initialDraftFor: (candidate) => {
    // Detect the heatmap request in either language (the demo suggestion is English by default, but a JA session may send Japanese).
    const isHeatmap = /ヒートマップ|heatmap/i.test(candidate.request ?? "");
    return {
      componentType: isHeatmap ? "sales.calendarHeatmap" : "sales.customViz1",
      version: "1.0.0",
      intentName: isHeatmap ? "sales.calendar_heatmap" : "sales.custom_viz_1",
      description: isHeatmap
        ? "Display sales as a monthly calendar heatmap"
        : (candidate.request ?? "Promoted visualization part"),
      paramsJsonSchema: TREND_PARAMS_SCHEMA,
      queryPath: "trend",
      fixedParams: TREND_FIXED_PARAMS,
      paramMap: TREND_PARAM_MAP,
    };
  },
};

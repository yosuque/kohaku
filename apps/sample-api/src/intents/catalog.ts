import { formatQueryRef } from "@kohaku-ui/data-binding";
import { defineIntent, type FacetSpec, type IntentBuilder, type IntentDef } from "@kohaku-ui/intents";
import type { JsonObject, QueryHandle } from "@kohaku-ui/spec-core";
import { z } from "zod";
import {
  channel,
  DEMO_FISCAL_YEAR,
  DEMO_QUARTER_ATTAINMENT,
  DEMO_QUARTER_SUMMARY,
  FISCAL_YEAR_MAX,
  FISCAL_YEAR_MIN,
  fiscalYear,
  granularity,
  groupBy,
  metric,
  quarter,
  region,
} from "./vocab.js";

/**
 * IntentDef is defined solely in @kohaku-ui/intents. Because the SemanticPort implementation
 * (semantic-port.ts) and promoted.ts reference this type, we re-export it here as the product boundary.
 */
export type { IntentDef };

const SOURCE = "sales";

/**
 * Query-ref helper for the callback escape hatch of by_product / kpi_overview / custom (source=sales fixed).
 * Keeps as legacy logic the cases a declarative template cannot express: "1 intent -> metric swap across
 * multiple queries", "params-independent fixed trend", and "conditional omission of a default-valued param"
 * (not everything is forced into templates).
 */
function ref(path: string, params: Record<string, string | number | undefined>): QueryHandle {
  const cleaned = Object.fromEntries(
    Object.entries(params)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => [k, String(v)]),
  );
  return { uri: formatQueryRef({ source: SOURCE, path, params: cleaned }) };
}

/**
 * Curated facet options for numeric ranges (fiscal year / quarter; a display curation, not a value set).
 * FY_OPTIONS is derived from the single fiscal-year range (vocab.ts FISCAL_YEAR_MIN/MAX) so the two stay in sync.
 */
const FY_OPTIONS = Array.from({ length: FISCAL_YEAR_MAX - FISCAL_YEAR_MIN + 1 }, (_, i) => {
  const year = FISCAL_YEAR_MIN + i;
  return { value: String(year), label: `FY${year}`, labels: { ja: `${year}年度` } };
});
// Q1-Q4 read the same in both languages — no overlay.
const QUARTER_OPTIONS = [1, 2, 3, 4].map((q) => ({ value: String(q), label: `Q${q}` }));

/** Shared facet-label overlays (the same facet keys repeat across intents). */
const JA = {
  fiscalYear: { ja: "会計年度" },
  quarter: { ja: "四半期" },
  region: { ja: "地域" },
  allRegions: { ja: "すべての地域" },
  allPeriods: { ja: "全期間" },
  fullYear: { ja: "通年" },
} as const;

/** Facet descriptor for the fiscalYear param (options: FY_OPTIONS). `empty` adds "All periods" clearing. */
function fiscalYearFacet(opts: { empty?: boolean } = {}): FacetSpec {
  return {
    param: "fiscalYear",
    label: "Fiscal year",
    labels: JA.fiscalYear,
    options: FY_OPTIONS,
    ...(opts.empty ? { emptyLabel: "All periods", emptyLabels: JA.allPeriods } : {}),
  };
}

/** Facet descriptor for the quarter param (options: QUARTER_OPTIONS). `empty` adds "Full year" clearing. */
function quarterFacet(opts: { empty?: boolean } = {}): FacetSpec {
  return {
    param: "quarter",
    label: "Quarter",
    labels: JA.quarter,
    options: QUARTER_OPTIONS,
    ...(opts.empty ? { emptyLabel: "Full year", emptyLabels: JA.fullYear } : {}),
  };
}

/** Facet descriptor for the region param (options: the region vocabulary). Always clearable ("All regions"). */
function regionFacet(): FacetSpec {
  return {
    param: "region",
    label: "Region",
    labels: JA.region,
    options: region,
    emptyLabel: "All regions",
    emptyLabels: JA.allRegions,
  };
}

/**
 * The single set of definitions for the normalized Intents this sample supports.
 * From one defineIntent we derive the SemanticPort IntentDef (toIntentDef), the GUI facet descriptor
 * (toFacetView, consumed by the facet-views.json codegen), and the MCP source (toToolSource).
 */
export const INTENT_DEFINITIONS: IntentBuilder[] = [
  defineIntent({
    canonical: "sales.quarterly_summary",
    description: "Aggregate the sales for the given quarter by region/product/channel",
    source: SOURCE,
    viewLabel: "Quarterly Summary",
    viewLabels: { ja: "四半期サマリー" },
    params: z.object({
      fiscalYear: fiscalYear.default(DEMO_FISCAL_YEAR),
      quarter: quarter.default(DEMO_QUARTER_SUMMARY),
      groupBy: groupBy.enum().default("region"),
      region: region.enum().optional(),
    }),
    // The example asking for this period's per-product sales (which can read as the whole fiscal year) would misdirect to
    // this Intent, where quarter is required, so it was moved to sales.by_product (quarter optional = can express full year).
    // Examples are bilingual: English (default demo) plus the Japanese originals (multilingual NL demo).
    examples: [
      "FY2026 Q3 sales by region as a chart",
      "Q2 actuals by channel",
      "2026年度Q3の地域別売上をグラフで",
      "Q2のチャネル別実績",
    ],
    facets: [
      fiscalYearFacet(),
      quarterFacet(),
      { param: "groupBy", label: "Group by", labels: { ja: "集計軸" }, options: groupBy },
      regionFacet(),
    ],
    queries: [
      { path: "summary", paramMap: { fiscalYear: "fy", quarter: "q", groupBy: "groupBy", region: "region" } },
    ],
    drilldown: (current, payload) => {
      // Click on an aggregation row -> narrow to that region and drill down to per-product.
      // The row's displayed value is a display label, so normalize to the region code whether a
      // label or a code arrives (Vocabulary.reverseLabel reverse-maps display label -> code; for a code it
      // returns undefined -> pass through).
      const clicked = String(payload["drilldown"] ?? "");
      const regionCode = region.reverseLabel(clicked) ?? clicked;
      if (current["groupBy"] === "region" && regionCode !== "") {
        return { params: { ...current, region: regionCode, groupBy: "product" } };
      }
      return { params: current };
    },
  }),

  defineIntent({
    canonical: "sales.trend",
    description: "Show the time-series trend of revenue or units (monthly/quarterly)",
    source: SOURCE,
    viewLabel: "Trend",
    viewLabels: { ja: "推移" },
    params: z.object({
      fiscalYear: fiscalYear.optional(),
      region: region.enum().optional(),
      productId: z.string().optional(),
      metric: metric.enum().default("revenue"),
      granularity: granularity.enum().default("month"),
    }),
    examples: [
      "Monthly revenue trend",
      "Show me the APAC trend",
      "Quarterly units trend",
      "売上の月次推移",
      "APACのトレンドを見せて",
      "四半期ごとの販売数推移",
    ],
    // productId is not exposed as a facet (NL / drilldown only).
    facets: [
      fiscalYearFacet({ empty: true }),
      regionFacet(),
      { param: "metric", label: "Metric", labels: { ja: "指標" }, options: metric },
      { param: "granularity", label: "Granularity", labels: { ja: "粒度" }, options: granularity },
    ],
    queries: [
      {
        path: "trend",
        paramMap: {
          fiscalYear: "fy",
          region: "region",
          productId: "productId",
          metric: "metric",
          granularity: "granularity",
        },
      },
    ],
  }),

  defineIntent({
    canonical: "sales.by_product",
    description: "Show the sales ranking by product (top N)",
    source: SOURCE,
    viewLabel: "Product Ranking",
    viewLabels: { ja: "製品ランキング" },
    params: z.object({
      fiscalYear: fiscalYear.default(DEMO_FISCAL_YEAR),
      quarter: quarter.optional(),
      region: region.enum().optional(),
      metric: metric.enum().default("revenue"),
      topN: z.coerce.number().int().min(1).max(20).default(5),
    }),
    // The "this period's per-product sales" example was moved from quarterly_summary (where quarter is required)
    // (this Intent has quarter optional, so it can take a whole-fiscal-year = full-year question without misdirection).
    examples: [
      "Top 5 products by revenue",
      "What are this period's sales by product?",
      "Which product is selling best this period?",
      "製品別売上トップ5",
      "今期の製品別売上は?",
      "今期一番売れている製品は?",
    ],
    // metric is not exposed as a facet (NL only). topN is a curated subset of a numeric range.
    facets: [
      fiscalYearFacet(),
      quarterFacet({ empty: true }),
      regionFacet(),
      {
        param: "topN",
        label: "Count",
        labels: { ja: "件数" },
        options: [
          { value: "3", label: "Top 3", labels: { ja: "上位3件" } },
          { value: "5", label: "Top 5", labels: { ja: "上位5件" } },
          { value: "10", label: "Top 10", labels: { ja: "上位10件" } },
        ],
      },
    ],
    // Propagate metric to the summary query (the basis for sorting and topN slicing; a missing propagation was
    // the bug where a "units top 5" request returned the revenue top 5). Because a declarative template (paramMap) can
    // only express "always attach if a value exists", the callback escape hatch **omits metric when it is the
    // default "revenue"** (default omission — keeps the existing canonical URIs, cache keys, and goldens unchanged).
    queries: (p) => [
      ref("summary", {
        fy: p["fiscalYear"] as number,
        q: p["quarter"] as number | undefined,
        region: p["region"] as string | undefined,
        topN: p["topN"] as number,
        groupBy: "product",
        metric: p["metric"] === "units" ? "units" : undefined,
      }),
    ],
  }),

  defineIntent({
    canonical: "sales.kpi_overview",
    description:
      "Show this period's summary KPIs (total revenue, YoY, top region, target attainment) as cards",
    source: SOURCE,
    viewLabel: "KPI Overview",
    viewLabels: { ja: "KPI概況" },
    params: z.object({
      fiscalYear: fiscalYear.default(DEMO_FISCAL_YEAR),
      quarter: quarter.optional(),
    }),
    examples: [
      "This quarter's summary",
      "List the KPIs",
      "Show the performance highlights",
      "今四半期のサマリー",
      "KPIを一覧で",
      "業績のハイライトを見せて",
    ],
    facets: [fiscalYearFacet(), quarterFacet({ empty: true })],
    // 1 intent -> 4 queries (metric swap) keeps its legacy logic via the callback escape hatch.
    queries: (p) => {
      const base = { fy: p["fiscalYear"] as number, q: p["quarter"] as number | undefined };
      return [
        ref("kpi", { ...base, metric: "total_revenue" }),
        ref("kpi", { ...base, metric: "yoy" }),
        ref("kpi", { ...base, metric: "top_region" }),
        ref("kpi", { ...base, metric: "target_attainment" }),
      ];
    },
  }),

  defineIntent({
    canonical: "sales.records",
    description: "List the sales records (raw rows)",
    source: SOURCE,
    viewLabel: "Records",
    viewLabels: { ja: "明細" },
    params: z.object({
      fiscalYear: fiscalYear.optional(),
      quarter: quarter.optional(),
      region: region.enum().optional(),
      productId: z.string().optional(),
      channel: channel.enum().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }),
    examples: [
      "Show me Japan direct-sales records",
      "List the sales records",
      "日本の直販の明細を見せて",
      "売上明細一覧",
    ],
    // productId / limit are not exposed as facets (NL / paging only).
    facets: [
      fiscalYearFacet({ empty: true }),
      quarterFacet({ empty: true }),
      regionFacet(),
      {
        param: "channel",
        label: "Channel",
        labels: { ja: "チャネル" },
        options: channel,
        emptyLabel: "All channels",
        emptyLabels: { ja: "すべてのチャネル" },
      },
    ],
    queries: [
      {
        path: "records",
        paramMap: {
          fiscalYear: "fy",
          quarter: "q",
          region: "region",
          productId: "productId",
          channel: "channel",
          limit: "limit",
        },
      },
    ],
  }),

  defineIntent({
    canonical: "sales.target_attainment",
    description: "Show targets, actuals, and attainment by region",
    source: SOURCE,
    viewLabel: "Target Attainment",
    viewLabels: { ja: "目標達成" },
    params: z.object({
      fiscalYear: fiscalYear.default(DEMO_FISCAL_YEAR),
      quarter: quarter.default(DEMO_QUARTER_ATTAINMENT),
    }),
    examples: [
      "What's the Q2 target attainment?",
      "Show attainment by region",
      "Q2の目標達成状況は?",
      "地域別の達成率を見せて",
    ],
    facets: [fiscalYearFacet(), quarterFacet()],
    queries: [
      { path: "targets", paramMap: { fiscalYear: "fy", quarter: "q" } },
      {
        path: "kpi",
        paramMap: { fiscalYear: "fy", quarter: "q" },
        fixedParams: { metric: "target_attainment" },
      },
    ],
  }),

  defineIntent({
    canonical: "sales.custom",
    description:
      "A free-form visualization request that no known Intent can express (routed to L2 free generation). Holds the original request text in params.request",
    params: z.object({
      request: z.string().min(1),
      baseIntent: z.string().optional(),
    }),
    examples: [
      // Examples must be achievable from the supplied primary ref (monthly trend {month, revenue}); do not
      // advertise forms that need dimensions the L2 widget cannot fetch (e.g. a region × product matrix —
      // the sandbox allows only the primary ref, so a second ref fails with ERR_REF_NOT_ALLOWED).
      "Sales as a calendar heatmap",
      "Show monthly sales as a waterfall chart",
      "売上をカレンダーヒートマップで",
      "月次売上をウォーターフォールで見たい",
    ],
    // No facets (not exposed in the GUI view). The fixed trend uses the callback escape hatch.
    queries: () => [
      // Primary data for the L2 widget: monthly trend (the most general-purpose material for free-form visualization)
      ref("trend", { fy: DEMO_FISCAL_YEAR, metric: "revenue", granularity: "month" }),
    ],
  }),
];

/** The SemanticPort IntentDefs (derived from the single definitions). All existing consumers reference this. */
export const INTENT_DEFS: IntentDef[] = INTENT_DEFINITIONS.map((d) => d.toIntentDef());

export class IntentCatalog {
  private defs = new Map<string, IntentDef>(INTENT_DEFS.map((d) => [d.name, d]));

  get(name: string): IntentDef | undefined {
    return this.defs.get(name);
  }

  list(): IntentDef[] {
    return [...this.defs.values()];
  }

  names(): string[] {
    return [...this.defs.keys()];
  }

  /** Adds a dynamic Intent from promotion (merged in from .data/intents.json) */
  add(def: IntentDef): void {
    this.defs.set(def.name, def);
  }

  /**
   * Removes a dynamic Intent on promotion withdrawal (unpublish).
   * Core Intents (INTENT_DEFS) are not added via promotion, so this is only called to remove promoted ones.
   */
  remove(name: string): void {
    this.defs.delete(name);
  }

  /** Validates params and returns the normalized form with defaults filled in. Returns null on failure. */
  normalizeParams(name: string, params: JsonObject): JsonObject | null {
    const def = this.defs.get(name);
    if (def == null) return null;
    const parsed = def.params.safeParse(params);
    return parsed.success ? (parsed.data as JsonObject) : null;
  }
}

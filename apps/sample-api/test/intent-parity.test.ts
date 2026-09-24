import type { JsonObject } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createSalesIntentCatalog, INTENT_DEFS } from "../src/intents/catalog.js";

/**
 * Parity diff test for the migration to the Intent DSL (@kohaku-ui/intents).
 * The expected values bake in goldens mechanically captured from the pre-migration (hand-written IntentDef) code.
 * Pins that normalizeParams (coerce + default filling) / toQueries (canonical URI) / drilldown do not change by even
 * a single byte across the migration, over representative inputs (NL-derived params, GUI-derived strings, drilldown,
 * boundary values, default filling).
 */
const catalog = createSalesIntentCatalog();
function defOf(name: string) {
  const def = INTENT_DEFS.find((d) => d.name === name);
  if (def == null) throw new Error(`intent not found: ${name}`);
  return def;
}

interface NormCase {
  intent: string;
  input: JsonObject;
  normalized: JsonObject;
  queries: string[];
}

// Pre-migration goldens (captured with capture-golden).
const NORM_CASES: NormCase[] = [
  {
    intent: "sales.quarterly_summary",
    input: {},
    normalized: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
    queries: ["query://sales/summary?fy=2026&groupBy=region&q=3"],
  },
  {
    intent: "sales.quarterly_summary",
    input: { fiscalYear: "2026", quarter: "3", groupBy: "region" },
    normalized: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
    queries: ["query://sales/summary?fy=2026&groupBy=region&q=3"],
  },
  {
    intent: "sales.quarterly_summary",
    input: { fiscalYear: "2025", quarter: "1", groupBy: "product", region: "japan" },
    normalized: { fiscalYear: 2025, quarter: 1, groupBy: "product", region: "japan" },
    queries: ["query://sales/summary?fy=2025&groupBy=product&q=1&region=japan"],
  },
  {
    intent: "sales.quarterly_summary",
    input: { groupBy: "channel" },
    normalized: { fiscalYear: 2026, quarter: 3, groupBy: "channel" },
    queries: ["query://sales/summary?fy=2026&groupBy=channel&q=3"],
  },
  {
    intent: "sales.quarterly_summary",
    input: { quarter: "4", fiscalYear: "2025" },
    normalized: { fiscalYear: 2025, quarter: 4, groupBy: "region" },
    queries: ["query://sales/summary?fy=2025&groupBy=region&q=4"],
  },
  {
    intent: "sales.trend",
    input: {},
    normalized: { metric: "revenue", granularity: "month" },
    queries: ["query://sales/trend?granularity=month&metric=revenue"],
  },
  {
    intent: "sales.trend",
    input: { metric: "units", granularity: "quarter", region: "apac" },
    normalized: { region: "apac", metric: "units", granularity: "quarter" },
    queries: ["query://sales/trend?granularity=quarter&metric=units&region=apac"],
  },
  {
    intent: "sales.trend",
    input: { fiscalYear: "2026", productId: "p-1" },
    normalized: { fiscalYear: 2026, productId: "p-1", metric: "revenue", granularity: "month" },
    queries: ["query://sales/trend?fy=2026&granularity=month&metric=revenue&productId=p-1"],
  },
  {
    intent: "sales.by_product",
    input: {},
    normalized: { fiscalYear: 2026, metric: "revenue", topN: 5 },
    queries: ["query://sales/summary?fy=2026&groupBy=product&topN=5"],
  },
  {
    intent: "sales.by_product",
    input: { topN: "10", region: "japan", quarter: "2" },
    normalized: { fiscalYear: 2026, quarter: 2, region: "japan", metric: "revenue", topN: 10 },
    queries: ["query://sales/summary?fy=2026&groupBy=product&q=2&region=japan&topN=10"],
  },
  {
    intent: "sales.by_product",
    input: { topN: "3" },
    normalized: { fiscalYear: 2026, metric: "revenue", topN: 3 },
    queries: ["query://sales/summary?fy=2026&groupBy=product&topN=3"],
  },
  {
    intent: "sales.kpi_overview",
    input: {},
    normalized: { fiscalYear: 2026 },
    queries: [
      "query://sales/kpi?fy=2026&metric=total_revenue",
      "query://sales/kpi?fy=2026&metric=yoy",
      "query://sales/kpi?fy=2026&metric=top_region",
      "query://sales/kpi?fy=2026&metric=target_attainment",
    ],
  },
  {
    intent: "sales.kpi_overview",
    input: { fiscalYear: "2025", quarter: "4" },
    normalized: { fiscalYear: 2025, quarter: 4 },
    queries: [
      "query://sales/kpi?fy=2025&metric=total_revenue&q=4",
      "query://sales/kpi?fy=2025&metric=yoy&q=4",
      "query://sales/kpi?fy=2025&metric=top_region&q=4",
      "query://sales/kpi?fy=2025&metric=target_attainment&q=4",
    ],
  },
  {
    intent: "sales.records",
    input: {},
    normalized: { limit: 100 },
    queries: ["query://sales/records?limit=100"],
  },
  {
    intent: "sales.records",
    input: { region: "europe", channel: "partner", limit: "50", quarter: "2" },
    normalized: { quarter: 2, region: "europe", channel: "partner", limit: 50 },
    queries: ["query://sales/records?channel=partner&limit=50&q=2&region=europe"],
  },
  {
    intent: "sales.records",
    input: { productId: "p-2", fiscalYear: "2025" },
    normalized: { fiscalYear: 2025, productId: "p-2", limit: 100 },
    queries: ["query://sales/records?fy=2025&limit=100&productId=p-2"],
  },
  {
    intent: "sales.target_attainment",
    input: {},
    normalized: { fiscalYear: 2026, quarter: 2 },
    queries: ["query://sales/targets?fy=2026&q=2", "query://sales/kpi?fy=2026&metric=target_attainment&q=2"],
  },
  {
    intent: "sales.target_attainment",
    input: { fiscalYear: "2025", quarter: "3" },
    normalized: { fiscalYear: 2025, quarter: 3 },
    queries: ["query://sales/targets?fy=2025&q=3", "query://sales/kpi?fy=2025&metric=target_attainment&q=3"],
  },
  {
    intent: "sales.custom",
    input: { request: "売上をヒートマップで" },
    normalized: { request: "売上をヒートマップで" },
    queries: ["query://sales/trend?fy=2026&granularity=month&metric=revenue"],
  },
  {
    intent: "sales.custom",
    input: { request: "x", baseIntent: "sales.trend" },
    normalized: { request: "x", baseIntent: "sales.trend" },
    queries: ["query://sales/trend?fy=2026&granularity=month&metric=revenue"],
  },
];

describe("normalizeParams parity (pre-migration golden)", () => {
  it.each(NORM_CASES)("$intent #%# normalizes identically to the pre-migration golden", (c) => {
    expect(catalog.normalizeParams(c.intent, c.input)).toEqual(c.normalized);
  });
});

describe("toQueries parity (pre-migration golden)", () => {
  it.each(NORM_CASES)("$intent #%# yields the same query URI as the pre-migration golden", (c) => {
    const norm = catalog.normalizeParams(c.intent, c.input);
    expect(norm).not.toBeNull();
    const uris = defOf(c.intent)
      .toQueries(norm as JsonObject)
      .map((q) => q.uri);
    expect(uris).toEqual(c.queries);
  });
});

interface DrillCase {
  intent: string;
  current: JsonObject;
  payload: JsonObject;
  drilldownParams: JsonObject;
  normalized: JsonObject;
}

const DRILL_CASES: DrillCase[] = [
  {
    intent: "sales.quarterly_summary",
    current: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
    payload: { drilldown: "Japan" },
    drilldownParams: { fiscalYear: 2026, quarter: 3, groupBy: "product", region: "japan" },
    normalized: { fiscalYear: 2026, quarter: 3, groupBy: "product", region: "japan" },
  },
  {
    intent: "sales.quarterly_summary",
    current: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
    payload: { drilldown: "apac" },
    drilldownParams: { fiscalYear: 2026, quarter: 3, groupBy: "product", region: "apac" },
    normalized: { fiscalYear: 2026, quarter: 3, groupBy: "product", region: "apac" },
  },
  {
    intent: "sales.quarterly_summary",
    current: { fiscalYear: 2026, quarter: 3, groupBy: "product" },
    payload: { drilldown: "Japan" },
    drilldownParams: { fiscalYear: 2026, quarter: 3, groupBy: "product" },
    normalized: { fiscalYear: 2026, quarter: 3, groupBy: "product" },
  },
  {
    intent: "sales.quarterly_summary",
    current: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
    payload: { drilldown: "" },
    drilldownParams: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
    normalized: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
  },
];

describe("drilldown parity (pre-migration golden)", () => {
  it.each(DRILL_CASES)("$intent #%# drilldown output matches the pre-migration golden", (c) => {
    const def = defOf(c.intent);
    const out = def.drilldown!(c.current, c.payload);
    expect(out.params).toEqual(c.drilldownParams);
    const canonical = out.canonical ?? c.intent;
    expect(catalog.normalizeParams(canonical, out.params)).toEqual(c.normalized);
  });
});

// ---- Below are not pre-migration goldens but regressions for code-review fixes ----

// Regression for metric propagation (a wrong-answer bugfix). By omitting the default value "revenue" from the URI (default omission),
// the existing canonical URIs, cache keys, and goldens are unchanged, and metric propagates to summary only when units is specified.
describe("sales.by_product metric propagation (default omitted)", () => {
  it("metric=units propagates to the summary query", () => {
    const norm = catalog.normalizeParams("sales.by_product", { metric: "units" });
    expect(norm).toEqual({ fiscalYear: 2026, metric: "units", topN: 5 });
    const uris = defOf("sales.by_product")
      .toQueries(norm as JsonObject)
      .map((q) => q.uri);
    expect(uris).toEqual(["query://sales/summary?fy=2026&groupBy=product&metric=units&topN=5"]);
  });

  it("the default metric=revenue is not emitted in the URI (identical to the legacy canonical URI)", () => {
    const norm = catalog.normalizeParams("sales.by_product", { metric: "revenue", quarter: "2" });
    expect(norm).toEqual({ fiscalYear: 2026, quarter: 2, metric: "revenue", topN: 5 });
    const uris = defOf("sales.by_product")
      .toQueries(norm as JsonObject)
      .map((q) => q.uri);
    expect(uris).toEqual(["query://sales/summary?fy=2026&groupBy=product&q=2&topN=5"]);
  });
});

// Regression for fixing a misleading example placement: the phrase 「今期の製品別売上は?」, which can read as a full-year query,
// is not placed on quarterly_summary (where quarter is required, default 3) — it belongs to by_product's examples (quarter optional = can express full-year).
describe("example placement (prevents misdirection to quarter-required Intents)", () => {
  it("「今期の製品別売上は?」 is an example of sales.by_product and absent from quarterly_summary", () => {
    expect(defOf("sales.by_product").examples).toContain("今期の製品別売上は?");
    expect(defOf("sales.quarterly_summary").examples).not.toContain("今期の製品別売上は?");
  });
});

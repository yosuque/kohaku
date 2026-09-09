import type { JsonObject } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineIntent } from "../src/intent.js";
import { defineVocabulary } from "../src/vocabulary.js";

const region = defineVocabulary("region", {
  japan: "Japan",
  north_america: "North America",
  europe: "Europe",
  apac: "APAC",
});
const groupBy = defineVocabulary("groupBy", {
  region: "By region",
  product: "By product",
  channel: "By channel",
});

/** Builds an Intent equivalent to quarterly_summary for testing (template path + drilldown). */
function summaryIntent() {
  return defineIntent({
    canonical: "sales.quarterly_summary",
    description: "Quarterly summary description",
    viewLabel: "Quarterly summary",
    source: "sales",
    params: z.object({
      fiscalYear: z.coerce.number().int().min(2025).max(2026).default(2026),
      quarter: z.coerce.number().int().min(1).max(4).default(3),
      groupBy: groupBy.enum().default("region"),
      region: region.enum().optional(),
    }),
    examples: ["this quarter's sales by region"],
    facets: [
      { param: "fiscalYear", label: "Fiscal year", options: [{ value: "2026", label: "FY2026" }] },
      { param: "groupBy", label: "Group by", options: groupBy },
      { param: "region", label: "Region", options: region, emptyLabel: "All regions" },
    ],
    queries: [
      { path: "summary", paramMap: { fiscalYear: "fy", quarter: "q", groupBy: "groupBy", region: "region" } },
    ],
    drilldown: (current, payload) => {
      const clicked = String(payload["drilldown"] ?? "");
      const code = region.reverseLabel(clicked) ?? clicked;
      if (current["groupBy"] === "region" && code !== "") {
        return { params: { ...current, region: code, groupBy: "product" } };
      }
      return { params: current };
    },
  });
}

describe("defineIntent.toIntentDef()", () => {
  it("returns fields of the same shape as the current IntentDef", () => {
    const def = summaryIntent().toIntentDef();
    expect(def.name).toBe("sales.quarterly_summary");
    expect(def.description).toBe("Quarterly summary description");
    expect(def.examples).toEqual(["this quarter's sales by region"]);
    expect(typeof def.toQueries).toBe("function");
    expect(typeof def.drilldown).toBe("function");
  });

  it("has no drilldown key when drilldown is unspecified", () => {
    const def = defineIntent({
      canonical: "x.y",
      description: "d",
      source: "sales",
      params: z.object({ a: z.string().optional() }),
      examples: [],
      queries: [{ path: "p", paramMap: { a: "a" } }],
    }).toIntentDef();
    expect("drilldown" in def).toBe(false);
  });
});

describe("toIntentDef().toQueries(QueryTemplate)", () => {
  it("expands paramMap + fixedParams into a canonical URI, excluding missing values", () => {
    const def = summaryIntent().toIntentDef();
    const uris = def.toQueries({ fiscalYear: 2026, quarter: 3, groupBy: "region" }).map((q) => q.uri);
    // region missing → excluded. Keys sorted.
    expect(uris).toEqual(["query://sales/summary?fy=2026&groupBy=region&q=3"]);
  });

  it("fixedParams are always applied", () => {
    const def = defineIntent({
      canonical: "sales.by_product",
      description: "d",
      source: "sales",
      params: z.object({ fiscalYear: z.coerce.number().default(2026), topN: z.coerce.number().default(5) }),
      examples: [],
      queries: [
        {
          path: "summary",
          paramMap: { fiscalYear: "fy", topN: "topN" },
          fixedParams: { groupBy: "product" },
        },
      ],
    }).toIntentDef();
    expect(def.toQueries({ fiscalYear: 2026, topN: 5 })[0]!.uri).toBe(
      "query://sales/summary?fy=2026&groupBy=product&topN=5",
    );
  });

  it("a template array maps 1 template → 1 query (multiple queries supported)", () => {
    const def = defineIntent({
      canonical: "sales.target_attainment",
      description: "d",
      source: "sales",
      params: z.object({
        fiscalYear: z.coerce.number().default(2026),
        quarter: z.coerce.number().default(2),
      }),
      examples: [],
      queries: [
        { path: "targets", paramMap: { fiscalYear: "fy", quarter: "q" } },
        {
          path: "kpi",
          paramMap: { fiscalYear: "fy", quarter: "q" },
          fixedParams: { metric: "target_attainment" },
        },
      ],
    }).toIntentDef();
    expect(def.toQueries({ fiscalYear: 2026, quarter: 2 }).map((q) => q.uri)).toEqual([
      "query://sales/targets?fy=2026&q=2",
      "query://sales/kpi?fy=2026&metric=target_attainment&q=2",
    ]);
  });

  it("the callback escape hatch is executed as-is", () => {
    const def = defineIntent({
      canonical: "sales.kpi_overview",
      description: "d",
      params: z.object({ fiscalYear: z.coerce.number().default(2026) }),
      examples: [],
      queries: (p: JsonObject) => [
        { uri: `query://sales/kpi?fy=${p["fiscalYear"]}&metric=total_revenue` },
        { uri: `query://sales/kpi?fy=${p["fiscalYear"]}&metric=yoy` },
      ],
    }).toIntentDef();
    expect(def.toQueries({ fiscalYear: 2026 }).map((q) => q.uri)).toEqual([
      "query://sales/kpi?fy=2026&metric=total_revenue",
      "query://sales/kpi?fy=2026&metric=yoy",
    ]);
  });

  it("an unspecified source on the template path throws at defineIntent time (fail-fast)", () => {
    expect(() =>
      defineIntent({
        canonical: "x",
        description: "d",
        params: z.object({ a: z.string().optional() }),
        examples: [],
        queries: [{ path: "p", paramMap: { a: "a" } }],
      }),
    ).toThrow();
  });
});

describe("toIntentDef().drilldown", () => {
  it("clicking a region aggregate row reverse-maps the localized name to a code and drills down by product", () => {
    const def = summaryIntent().toIntentDef();
    const out = def.drilldown!({ fiscalYear: 2026, quarter: 3, groupBy: "region" }, { drilldown: "Japan" });
    expect(out.params).toEqual({ fiscalYear: 2026, quarter: 3, groupBy: "product", region: "japan" });
  });

  it("stays unchanged when groupBy is not region", () => {
    const def = summaryIntent().toIntentDef();
    const current = { fiscalYear: 2026, quarter: 3, groupBy: "product" };
    expect(def.drilldown!(current, { drilldown: "Japan" }).params).toEqual(current);
  });
});

describe("defineIntent.toFacetView()", () => {
  it("derives facets into key/label/control/valueType/options/allowEmpty", () => {
    const view = summaryIntent().toFacetView();
    expect(view.intent).toBe("sales.quarterly_summary");
    expect(view.label).toBe("Quarterly summary"); // viewLabel takes priority
    expect(view.facets).toEqual([
      {
        key: "fiscalYear",
        label: "Fiscal year",
        control: "select",
        valueType: "number",
        options: [{ value: "2026", label: "FY2026" }],
      },
      {
        key: "groupBy",
        label: "Group by",
        control: "select",
        valueType: "string",
        options: [
          { value: "region", label: "By region" },
          { value: "product", label: "By product" },
          { value: "channel", label: "By channel" },
        ],
      },
      {
        key: "region",
        label: "Region",
        control: "select",
        valueType: "string",
        options: [
          { value: "japan", label: "Japan" },
          { value: "north_america", label: "North America" },
          { value: "europe", label: "Europe" },
          { value: "apac", label: "APAC" },
        ],
        allowEmpty: "All regions",
      },
    ]);
  });

  it("uses description as the view label when viewLabel is omitted", () => {
    const view = defineIntent({
      canonical: "x.y",
      description: "Description label",
      source: "sales",
      params: z.object({ a: region.enum().optional() }),
      examples: [],
      facets: [{ param: "a", label: "A" }],
      queries: [{ path: "p", paramMap: { a: "a" } }],
    }).toFacetView();
    expect(view.label).toBe("Description label");
  });

  it("omitting options with an enum param derives options from that enum (label is the value)", () => {
    const view = defineIntent({
      canonical: "x.y",
      description: "d",
      source: "sales",
      params: z.object({ a: region.enum().optional() }),
      examples: [],
      facets: [{ param: "a", label: "A" }],
      queries: [{ path: "p", paramMap: { a: "a" } }],
    }).toFacetView();
    expect(view.facets[0]!.options).toEqual([
      { value: "japan", label: "japan" },
      { value: "north_america", label: "north_america" },
      { value: "europe", label: "europe" },
      { value: "apac", label: "apac" },
    ]);
  });

  it("reorders by explicit order and respects an explicit control", () => {
    const view = defineIntent({
      canonical: "x.y",
      description: "d",
      source: "sales",
      params: z.object({ a: z.string().optional(), b: z.string().optional() }),
      examples: [],
      facets: [
        { param: "a", label: "A", order: 2, options: [{ value: "1", label: "one" }] },
        { param: "b", label: "B", order: 1, control: "radio", options: [{ value: "2", label: "two" }] },
      ],
      queries: [{ path: "p" }],
    }).toFacetView();
    expect(view.facets.map((f) => f.key)).toEqual(["b", "a"]);
    expect(view.facets[0]!.control).toBe("radio");
  });

  it("carries locale overlays (viewLabels / labels / emptyLabels / option labels) into the view", () => {
    const bilingualRegion = defineVocabulary("region", {
      japan: { en: "Japan", ja: "日本" },
      europe: "Europe",
    });
    const view = defineIntent({
      canonical: "x.y",
      description: "d",
      viewLabel: "Quarterly summary",
      viewLabels: { ja: "四半期サマリー" },
      source: "sales",
      params: z.object({
        region: bilingualRegion.enum().optional(),
        fiscalYear: z.coerce.number().default(2026),
      }),
      examples: [],
      facets: [
        {
          param: "region",
          label: "Region",
          labels: { ja: "地域" },
          options: bilingualRegion,
          emptyLabel: "All regions",
          emptyLabels: { ja: "すべての地域" },
        },
        {
          param: "fiscalYear",
          label: "Fiscal year",
          options: [{ value: "2026", label: "FY2026", labels: { ja: "2026年度" } }],
        },
      ],
      queries: [{ path: "p" }],
    }).toFacetView();
    expect(view.labels).toEqual({ ja: "四半期サマリー" });
    expect(view.facets[0]).toEqual({
      key: "region",
      label: "Region",
      labels: { ja: "地域" },
      control: "select",
      valueType: "string",
      options: [
        { value: "japan", label: "Japan", labels: { ja: "日本" } },
        { value: "europe", label: "Europe" },
      ],
      allowEmpty: "All regions",
      allowEmptyLabels: { ja: "すべての地域" },
    });
    expect(view.facets[1]!.options).toEqual([{ value: "2026", label: "FY2026", labels: { ja: "2026年度" } }]);
  });

  it("omits overlay keys entirely when not declared (keeps the emitted JSON minimal)", () => {
    const view = summaryIntent().toFacetView();
    expect("labels" in view).toBe(false);
    for (const facet of view.facets) {
      expect("labels" in facet).toBe(false);
      expect("allowEmptyLabels" in facet).toBe(false);
      for (const opt of facet.options) expect("labels" in opt).toBe(false);
    }
  });

  it("a facet param not present in params throws", () => {
    expect(() =>
      defineIntent({
        canonical: "x.y",
        description: "d",
        source: "sales",
        params: z.object({ a: z.string().optional() }),
        examples: [],
        facets: [{ param: "missing", label: "M", options: [{ value: "1", label: "one" }] }],
        queries: [{ path: "p" }],
      }).toFacetView(),
    ).toThrow();
  });
});

describe("valueType derivation (z.coerce.number → number / enum / string → string)", () => {
  it("coerce number (including default / optional wrappers) is number", () => {
    const view = defineIntent({
      canonical: "x.y",
      description: "d",
      source: "sales",
      params: z.object({
        n1: z.coerce.number().int().min(1).max(20).default(5),
        n2: z.coerce.number().int().optional(),
      }),
      examples: [],
      facets: [
        { param: "n1", label: "N1", options: [{ value: "5", label: "5" }] },
        { param: "n2", label: "N2", options: [{ value: "1", label: "1" }] },
      ],
      queries: [{ path: "p" }],
    }).toFacetView();
    expect(view.facets.map((f) => f.valueType)).toEqual(["number", "number"]);
  });

  it("enum / string is string", () => {
    const view = defineIntent({
      canonical: "x.y",
      description: "d",
      source: "sales",
      params: z.object({ e: region.enum().optional(), s: z.string().optional() }),
      examples: [],
      facets: [
        { param: "e", label: "E", options: region },
        { param: "s", label: "S", options: [{ value: "x", label: "x" }] },
      ],
      queries: [{ path: "p" }],
    }).toFacetView();
    expect(view.facets.map((f) => f.valueType)).toEqual(["string", "string"]);
  });
});

describe("toToolSource() / parseParams()", () => {
  it("toToolSource returns name/description/params (MCP input)", () => {
    const src = summaryIntent().toToolSource();
    expect(src.name).toBe("sales.quarterly_summary");
    expect(src.description).toBe("Quarterly summary description");
    expect(src.params.safeParse({ fiscalYear: "2026" }).success).toBe(true);
  });

  it("parseParams coerces and fills defaults", () => {
    const parsed = summaryIntent().parseParams({ fiscalYear: "2026", quarter: "3" });
    // coerce string → number; groupBy is filled by default.
    expect(parsed).toEqual({ fiscalYear: 2026, quarter: 3, groupBy: "region" });
  });
});

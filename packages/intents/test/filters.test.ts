import type { QueryHandle } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineIntent } from "../src/intent.js";
import { defineVocabulary } from "../src/vocabulary.js";

const region = defineVocabulary("region", {
  japan: { en: "Japan", ja: "日本" },
  europe: "Europe",
  apac: "APAC",
});
const groupBy = defineVocabulary("groupBy", {
  region: "By region",
  product: "By product",
});

function summary(overrides: { facets?: Parameters<typeof defineIntent>[0]["facets"] } = {}) {
  return defineIntent({
    canonical: "sales.summary",
    description: "Summary",
    source: "sales",
    params: z.object({
      fiscalYear: z.coerce.number().int().min(2025).max(2026).default(2026),
      groupBy: groupBy.enum().default("region"),
      region: region.enum().optional(),
      metric: z.enum(["revenue", "units"]).default("revenue"),
    }),
    examples: [],
    facets: overrides.facets ?? [
      { param: "fiscalYear", label: "Fiscal year", options: [{ value: "2026", label: "FY2026" }] },
      { param: "groupBy", label: "Group by", labels: { ja: "集計軸" }, options: groupBy },
      { param: "region", label: "Region", options: region, emptyLabel: "All regions" },
      { param: "metric", label: "Metric" },
    ],
    queries: [
      { path: "summary", paramMap: { fiscalYear: "fy", groupBy: "groupBy", region: "geo", metric: "m" } },
    ],
  });
}

describe("IntentDef.filters", () => {
  it("derives a descriptor per string-valued select facet, mapping queryParam through paramMap", () => {
    const def = summary().toIntentDef();
    const filters = def.filters?.();
    expect(filters).toEqual([
      {
        param: "groupBy",
        queryParam: "groupBy",
        paths: ["summary"],
        label: "Group by",
        options: [
          { value: "region", label: "By region" },
          { value: "product", label: "By product" },
        ],
      },
      {
        param: "region",
        queryParam: "geo",
        paths: ["summary"],
        label: "Region",
        options: [
          { value: "japan", label: "Japan" },
          { value: "europe", label: "Europe" },
          { value: "apac", label: "APAC" },
        ],
      },
      // `metric` has no options declaration: derived from the param's enum (label reuses value).
      {
        param: "metric",
        queryParam: "m",
        paths: ["summary"],
        label: "Metric",
        options: [
          { value: "revenue", label: "revenue" },
          { value: "units", label: "units" },
        ],
      },
    ]);
  });

  it("excludes a facet on a numeric param (fiscalYear) and a control:number facet", () => {
    const def = summary({
      facets: [
        { param: "fiscalYear", label: "Fiscal year", options: [{ value: "2026", label: "FY2026" }] },
        { param: "groupBy", label: "Group by", control: "number", options: groupBy },
      ],
    }).toIntentDef();
    expect(def.filters?.()).toEqual([]);
  });

  it("applies the locale overlay to the facet label and the option labels, falling back to canonical", () => {
    const def = summary().toIntentDef();
    const filters = def.filters?.("ja") ?? [];
    expect(filters.find((f) => f.param === "groupBy")?.label).toBe("集計軸");
    expect(filters.find((f) => f.param === "region")?.label).toBe("Region");
    expect(filters.find((f) => f.param === "region")?.options[0]).toEqual({ value: "japan", label: "日本" });
    expect(filters.find((f) => f.param === "region")?.options[1]).toEqual({
      value: "europe",
      label: "Europe",
    });
  });

  it("skips a facet whose param maps to different query params across queries (ambiguous), and an unmapped param", () => {
    const def = defineIntent({
      canonical: "sales.two",
      description: "Two queries",
      source: "sales",
      params: z.object({ groupBy: groupBy.enum().default("region"), region: region.enum().optional() }),
      examples: [],
      facets: [
        { param: "groupBy", label: "Group by", options: groupBy },
        { param: "region", label: "Region", options: region },
      ],
      queries: [
        { path: "a", paramMap: { groupBy: "g1" } },
        { path: "b", paramMap: { groupBy: "g2" } },
      ],
    }).toIntentDef();
    // groupBy maps to g1 and g2 (ambiguous); region is in no paramMap at all.
    expect(def.filters?.()).toEqual([]);
  });

  it("falls back from a regional tag to its primary subtag (ja-JP -> ja) and then to canonical", () => {
    const def = summary().toIntentDef();
    const jp = def.filters?.("ja-JP") ?? [];
    expect(jp.find((f) => f.param === "groupBy")?.label).toBe("集計軸");
    expect(jp.find((f) => f.param === "region")?.options[0]).toEqual({ value: "japan", label: "日本" });
    const fr = def.filters?.("fr-CA") ?? [];
    expect(fr.find((f) => f.param === "groupBy")?.label).toBe("Group by");
  });

  it("collects every template path that maps the param, and excludes a filter whose queryParam is fixed or shared", () => {
    const def = defineIntent({
      canonical: "sales.paths",
      description: "Paths",
      source: "sales",
      params: z.object({
        groupBy: groupBy.enum().default("region"),
        region: region.enum().optional(),
        other: z.enum(["a", "b"]).default("a"),
        fixedClash: z.enum(["x", "y"]).default("x"),
      }),
      examples: [],
      facets: [
        { param: "groupBy", label: "Group by", options: groupBy },
        { param: "region", label: "Region", options: region },
        { param: "other", label: "Other" },
        { param: "fixedClash", label: "Fixed clash" },
      ],
      queries: [
        { path: "a", paramMap: { groupBy: "g", region: "geo", other: "geo" } },
        { path: "b", paramMap: { groupBy: "g" }, fixedParams: { mode: "full", clash: "1" } },
        { path: "c", paramMap: { fixedClash: "clash" } },
      ],
    }).toIntentDef();
    // groupBy governs a and b; region/other both map "geo" on path a (two params, one queryParam => both
    // excluded); fixedClash's queryParam is a fixed parameter of path b (excluded).
    expect(def.filters?.().map((f) => [f.param, f.paths])).toEqual([["groupBy", ["a", "b"]]]);
  });

  it("skips a facet declared filterable: false (it still appears in toFacetView)", () => {
    const facets = [
      { param: "groupBy", label: "Group by", options: groupBy, filterable: false },
      { param: "region", label: "Region", options: region, emptyLabel: "All regions" },
    ];
    const builder = summary({ facets });
    expect(
      builder
        .toIntentDef()
        .filters?.()
        .map((f) => f.param),
    ).toEqual(["region"]);
    expect(builder.toFacetView().facets.map((f) => f.key)).toEqual(["groupBy", "region"]);
    // filterable defaults to true, and an explicit true behaves the same.
    const explicit = summary({ facets: facets.map((f) => ({ ...f, filterable: true })) });
    expect(
      explicit
        .toIntentDef()
        .filters?.()
        .map((f) => f.param),
    ).toEqual(["groupBy", "region"]);
  });

  it("is absent when queries is a callback (no paramMap to read the query param from)", () => {
    const def = defineIntent({
      canonical: "sales.callback",
      description: "Callback",
      params: z.object({ groupBy: groupBy.enum().default("region") }),
      examples: [],
      facets: [{ param: "groupBy", label: "Group by", options: groupBy }],
      queries: (p): QueryHandle[] => [{ uri: `query://sales/x?g=${String(p["groupBy"])}` }],
    }).toIntentDef();
    expect(def.filters).toBeUndefined();
  });

  it("does not change toFacetView() output", () => {
    const view = summary().toFacetView();
    expect(view.facets.map((f) => f.key)).toEqual(["fiscalYear", "groupBy", "region", "metric"]);
  });
});

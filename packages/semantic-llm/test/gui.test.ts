import { defineIntent, defineVocabulary } from "@kohaku-ui/intents";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createIntentCatalog, normalizeGuiAction } from "../src/index.js";

const region = defineVocabulary("region", { japan: "Japan", europe: "Europe" });
const catalog = createIntentCatalog([
  defineIntent({
    canonical: "sales.summary",
    description: "Summary",
    source: "sales",
    params: z.object({
      region: region.enum().optional(),
      groupBy: z.enum(["region", "product"]).default("region"),
    }),
    examples: [],
    queries: [{ path: "summary", paramMap: { region: "region", groupBy: "groupBy" } }],
    drilldown: (current, payload) => {
      const clicked =
        region.reverseLabel(String(payload["drilldown"] ?? "")) ?? String(payload["drilldown"] ?? "");
      return { params: { ...current, region: clicked, groupBy: "product" } };
    },
  }).toIntentDef(),
  defineIntent({
    canonical: "sales.records",
    description: "Records",
    source: "sales",
    params: z.object({ limit: z.coerce.number().int().default(100) }),
    examples: [],
    queries: [{ path: "records", paramMap: { limit: "limit" } }],
  }).toIntentDef(),
]);

describe("normalizeGuiAction", () => {
  it("view.select picks the Intent from params.intent and merges facets over current params of the same Intent", () => {
    const out = normalizeGuiAction(
      {
        kind: "gui",
        action: "view.select",
        params: { intent: "sales.summary", region: "japan" },
        current: { canonical: "sales.summary", params: { groupBy: "product" }, hash: "h" },
      },
      catalog,
    );
    expect(out).toEqual({ canonical: "sales.summary", params: { region: "japan", groupBy: "product" } });
  });

  it("facet.change onto a different Intent does not carry the old params over", () => {
    const out = normalizeGuiAction(
      {
        kind: "gui",
        action: "facet.change",
        params: { intent: "sales.records" },
        current: { canonical: "sales.summary", params: { groupBy: "product" }, hash: "h" },
      },
      catalog,
    );
    expect(out).toEqual({ canonical: "sales.records", params: { limit: 100 } });
  });

  it("a component event delegates to the Intent's drilldown (label → code reverse lookup happens in the definition)", () => {
    const out = normalizeGuiAction(
      {
        kind: "gui",
        action: "table1.rowClick",
        params: { drilldown: "Japan" },
        current: { canonical: "sales.summary", params: { groupBy: "region" }, hash: "h" },
      },
      catalog,
    );
    expect(out).toEqual({ canonical: "sales.summary", params: { region: "japan", groupBy: "product" } });
  });

  it("a component event without a drilldown merges the payload into the current params", () => {
    const out = normalizeGuiAction(
      {
        kind: "gui",
        action: "list.more",
        params: { limit: 200 },
        current: { canonical: "sales.records", params: { limit: 100 }, hash: "h" },
      },
      catalog,
    );
    expect(out).toEqual({ canonical: "sales.records", params: { limit: 200 } });
  });

  it("rejects unknown Intents, invalid params and unsupported actions", () => {
    expect(() =>
      normalizeGuiAction({ kind: "gui", action: "view.select", params: { intent: "nope" } }, catalog),
    ).toThrow(/unknown intent/);
    expect(() =>
      normalizeGuiAction(
        { kind: "gui", action: "view.select", params: { intent: "sales.summary", region: "mars" } },
        catalog,
      ),
    ).toThrow(/invalid params/);
    expect(() => normalizeGuiAction({ kind: "gui", action: "whatever", params: {} }, catalog)).toThrow(
      /unsupported gui action/,
    );
  });
});

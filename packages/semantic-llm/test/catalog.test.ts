import { defineIntent, defineVocabulary } from "@kohaku-ui/intents";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createIntentCatalog } from "../src/index.js";

const region = defineVocabulary("region", { japan: "Japan", europe: "Europe" });
const summary = defineIntent({
  canonical: "sales.summary",
  description: "Summary",
  source: "sales",
  params: z.object({ region: region.enum().optional(), topN: z.coerce.number().int().default(5) }),
  examples: ["summary"],
  queries: [{ path: "summary", paramMap: { region: "region", topN: "topN" } }],
}).toIntentDef();

describe("createIntentCatalog", () => {
  it("lists names, gets a definition and normalizes params with defaults", () => {
    const catalog = createIntentCatalog([summary]);
    expect(catalog.names()).toEqual(["sales.summary"]);
    expect(catalog.get("sales.summary")?.description).toBe("Summary");
    expect(catalog.normalizeParams("sales.summary", { region: "japan" })).toEqual({
      region: "japan",
      topN: 5,
    });
    expect(catalog.normalizeParams("sales.summary", { region: "mars" })).toBeNull();
    expect(catalog.normalizeParams("unknown", {})).toBeNull();
  });

  it("add / remove mutate the catalog (promotion adds an Intent, withdrawal removes it)", () => {
    const catalog = createIntentCatalog([summary]);
    catalog.add({ ...summary, name: "sales.promoted" });
    expect(catalog.names()).toEqual(["sales.summary", "sales.promoted"]);
    catalog.remove("sales.promoted");
    expect(catalog.names()).toEqual(["sales.summary"]);
  });

  it("revision moves only on an actual mutation (consumers cache on it)", () => {
    const catalog = createIntentCatalog([summary]);
    const initial = catalog.revision;
    catalog.add({ ...summary, name: "sales.promoted" });
    expect(catalog.revision).toBe(initial + 1);
    catalog.remove("does-not-exist");
    expect(catalog.revision).toBe(initial + 1);
    catalog.remove("sales.promoted");
    expect(catalog.revision).toBe(initial + 2);
  });
});

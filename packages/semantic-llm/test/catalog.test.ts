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

  describe("validateParams", () => {
    it("accepts valid params and returns the normalized form (defaults filled in)", () => {
      const catalog = createIntentCatalog([summary]);
      expect(catalog.validateParams("sales.summary", { region: "japan" })).toEqual({
        ok: true,
        params: { region: "japan", topN: 5 },
      });
    });

    it("rejects an unknown intent name (a single whole-Intent issue, empty path)", () => {
      const catalog = createIntentCatalog([summary]);
      expect(catalog.validateParams("sales.unknown", {})).toEqual({
        ok: false,
        issues: [{ path: "", message: 'unknown intent "sales.unknown"' }],
      });
    });

    it("rejects an invalid param value with a path-scoped issue (unlike normalizeParams' bare null)", () => {
      const catalog = createIntentCatalog([summary]);
      const result = catalog.validateParams("sales.summary", { region: "mars" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]!.path).toBe("region");
      expect(result.issues[0]!.message).toContain("region");
    });

    it('rejects an unknown param key that normalizeParams would silently strip (Zod\'s default "strip unrecognized keys" behavior)', () => {
      const catalog = createIntentCatalog([summary]);
      // normalizeParams (a plain safeParse) silently drops the unknown key and succeeds.
      expect(catalog.normalizeParams("sales.summary", { region: "japan", bogus: 1 })).toEqual({
        region: "japan",
        topN: 5,
      });
      // validateParams treats the same input as invalid instead.
      expect(catalog.validateParams("sales.summary", { region: "japan", bogus: 1 })).toEqual({
        ok: false,
        issues: [{ path: "bogus", message: 'unknown param "bogus"' }],
      });
    });

    it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
      "reports %s as an unknown key (an Object.prototype name is not a declared param)",
      (key) => {
        const catalog = createIntentCatalog([summary]);
        // JSON.parse so `__proto__` is an own property, as on a real parsed body.
        const params = JSON.parse(`{"region":"japan","${key}":1}`);
        expect(catalog.validateParams("sales.summary", params)).toEqual({
          ok: false,
          issues: [{ path: key, message: `unknown param "${key}"` }],
        });
      },
    );

    it("reports both an unknown key and an invalid value together", () => {
      const catalog = createIntentCatalog([summary]);
      const result = catalog.validateParams("sales.summary", { region: "mars", bogus: 1 });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      const paths = result.issues.map((issue) => issue.path).sort();
      expect(paths).toEqual(["bogus", "region"]);
    });
  });
});

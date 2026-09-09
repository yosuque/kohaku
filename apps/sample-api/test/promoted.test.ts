import { toPropsJsonSchema } from "@kohaku-ui/registry";
import type { JsonObject } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type PromotedEntry, promotedComponent, promotedIntent } from "../src/intents/promoted.js";

function entry(draft: PromotedEntry["draft"]): PromotedEntry {
  return { artifactId: "sha256:test", draft, html: "<div></div>", publishedAt: "2026-07-02T00:00:00Z" };
}

describe("promotedComponent(draft.paramsJsonSchema → propsSchema)", () => {
  it("when paramsJsonSchema exists it is reflected in propsSchema and passes toPropsJsonSchema without throwing", () => {
    const def = promotedComponent(
      entry({
        componentType: "sales.calendarHeatmap",
        version: "1.0.0",
        intentName: "sales.calendar_heatmap",
        description: "Sales heatmap",
        paramsJsonSchema: {
          type: "object",
          properties: {
            fiscalYear: { type: "integer", default: 2026 },
            region: { type: "string", enum: ["japan", "apac"] },
          },
        },
      }),
    );
    // The props schema can be output as JSON Schema and has the declared properties.
    const json = toPropsJsonSchema(def) as { properties?: Record<string, unknown> };
    expect(json.properties).toHaveProperty("fiscalYear");
    expect(json.properties).toHaveProperty("region");
    expect(def.implementation?.kind).toBe("sandbox-template");
  });

  it("without paramsJsonSchema, keeps the current {title?} default", () => {
    const def = promotedComponent(
      entry({
        componentType: "sales.customViz1",
        version: "1.0.0",
        intentName: "sales.custom_viz_1",
        description: "freely generated component",
      }),
    );
    const json = toPropsJsonSchema(def) as { properties?: Record<string, unknown> };
    expect(Object.keys(json.properties ?? {})).toEqual(["title"]);
  });
});

describe("promotedIntent(queryTemplate → formatQueryRef)", () => {
  it("when queryTemplate exists, expands fixedParams + paramMap into a canonical URI", () => {
    const intent = promotedIntent(
      entry({
        componentType: "sales.calendarHeatmap",
        version: "1.0.0",
        intentName: "sales.calendar_heatmap",
        description: "Sales heatmap",
        paramsJsonSchema: {
          type: "object",
          properties: {
            fiscalYear: { type: "integer", default: 2026 },
            region: { type: "string", enum: ["japan", "apac"] },
          },
        },
        queryTemplate: {
          path: "trend",
          fixedParams: { metric: "revenue", granularity: "month" },
          paramMap: { fiscalYear: "fy", region: "region" },
        },
      }),
    );
    // Accept GUI-derived string input (fiscalYear:"2026") via coerce.
    const params = intent.params.parse({ fiscalYear: "2026", region: "japan" });
    const queries = intent.toQueries(params as JsonObject);
    // The canonical form is key-sorted (fy, granularity, metric, region).
    expect(queries).toHaveLength(1);
    expect(queries[0]!.uri).toBe("query://sales/trend?fy=2026&granularity=month&metric=revenue&region=japan");
  });

  it("omits a query param when its paramMap value is missing", () => {
    const intent = promotedIntent(
      entry({
        componentType: "sales.calendarHeatmap",
        version: "1.0.0",
        intentName: "sales.calendar_heatmap",
        description: "Sales heatmap",
        paramsJsonSchema: {
          type: "object",
          properties: {
            fiscalYear: { type: "integer", default: 2026 },
            region: { type: "string", enum: ["japan", "apac"] },
          },
        },
        queryTemplate: {
          path: "trend",
          fixedParams: { metric: "revenue", granularity: "month" },
          paramMap: { fiscalYear: "fy", region: "region" },
        },
      }),
    );
    const params = intent.params.parse({ fiscalYear: 2026 }); // region omitted
    const queries = intent.toQueries(params as JsonObject);
    expect(queries[0]!.uri).toBe("query://sales/trend?fy=2026&granularity=month&metric=revenue");
  });

  it("without queryTemplate, falls back to the legacy promoted.json-compatible fixed trend logic", () => {
    const intent = promotedIntent(
      entry({
        componentType: "sales.customViz1",
        version: "1.0.0",
        intentName: "sales.custom_viz_1",
        description: "freely generated component",
      }),
    );
    const params = intent.params.parse({ fiscalYear: 2026, region: "apac" });
    const queries = intent.toQueries(params as JsonObject);
    expect(queries[0]!.uri).toBe("query://sales/trend?fy=2026&granularity=month&metric=revenue&region=apac");
  });
});

describe("promotedIntent (boolean coercion preprocessing)", () => {
  function flagIntent() {
    return promotedIntent(
      entry({
        componentType: "sales.flagViz",
        version: "1.0.0",
        intentName: "sales.flag_viz",
        description: "visualization with a flag",
        paramsJsonSchema: {
          type: "object",
          properties: { cumulative: { type: "boolean" } },
        },
      }),
    );
  }

  it('string "false"/"0" becomes false (does not use Boolean())', () => {
    const intent = flagIntent();
    expect((intent.params.parse({ cumulative: "false" }) as JsonObject)["cumulative"]).toBe(false);
    expect((intent.params.parse({ cumulative: "0" }) as JsonObject)["cumulative"]).toBe(false);
  });

  it('string "true"/"1" and booleans are interpreted as-is', () => {
    const intent = flagIntent();
    expect((intent.params.parse({ cumulative: "true" }) as JsonObject)["cumulative"]).toBe(true);
    expect((intent.params.parse({ cumulative: "1" }) as JsonObject)["cumulative"]).toBe(true);
    expect((intent.params.parse({ cumulative: false }) as JsonObject)["cumulative"]).toBe(false);
    expect((intent.params.parse({ cumulative: true }) as JsonObject)["cumulative"]).toBe(true);
  });

  it("a value that cannot be interpreted as boolean becomes a validation error", () => {
    const intent = flagIntent();
    expect(() => intent.params.parse({ cumulative: "maybe" })).toThrow();
  });
});

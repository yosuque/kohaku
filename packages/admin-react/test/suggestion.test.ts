import type { SchemaSuggestionView } from "@kohaku-ui/client";
import { describe, expect, it } from "vitest";
import { diffAgainstSuggestion, draftFormFromSuggestion, hasEdits } from "../src/index.js";

const SUGGESTION: SchemaSuggestionView = {
  draft: {
    componentType: "sales.calendarHeatmap",
    version: "1.0.0",
    intentName: "sales.calendar_heatmap",
    description: "Display sales as a monthly calendar heatmap",
    paramsJsonSchema: { type: "object", properties: { fiscalYear: { type: "integer", default: 2026 } } },
    queryTemplate: {
      path: "trend",
      fixedParams: { metric: "revenue", granularity: "month" },
      paramMap: { fiscalYear: "fy" },
    },
  },
  events: [],
  confidence: 0.9,
  model: "fake-model",
  extractorId: "l2-schema-extraction",
  extractorVersion: "0.1",
  suggestedAt: "2026-07-01T00:00:00.000Z",
};

describe("draftFormFromSuggestion", () => {
  it("serializes the suggested draft into the form's text fields", () => {
    const form = draftFormFromSuggestion(SUGGESTION);
    expect(form.componentType).toBe("sales.calendarHeatmap");
    expect(form.version).toBe("1.0.0");
    expect(form.intentName).toBe("sales.calendar_heatmap");
    expect(form.description).toBe("Display sales as a monthly calendar heatmap");
    expect(JSON.parse(form.paramsJsonSchema)).toEqual(SUGGESTION.draft.paramsJsonSchema);
    expect(form.queryPath).toBe("trend");
    expect(JSON.parse(form.fixedParams)).toEqual({ metric: "revenue", granularity: "month" });
    expect(JSON.parse(form.paramMap)).toEqual({ fiscalYear: "fy" });
  });
  it("leaves the wiring fields empty when the suggestion has no queryTemplate", () => {
    const form = draftFormFromSuggestion({
      ...SUGGESTION,
      draft: { ...SUGGESTION.draft, queryTemplate: undefined },
    });
    expect(form.queryPath).toBe("");
    expect(form.fixedParams).toBe("");
    expect(form.paramMap).toBe("");
  });
});

describe("diffAgainstSuggestion", () => {
  it("is all-unchanged for the untouched prefill", () => {
    const diff = diffAgainstSuggestion(draftFormFromSuggestion(SUGGESTION), SUGGESTION);
    expect(diff.map((d) => d.field)).toEqual([
      "componentType",
      "version",
      "intentName",
      "description",
      "paramsJsonSchema",
      "queryPath",
      "fixedParams",
      "paramMap",
    ]);
    expect(hasEdits(diff)).toBe(false);
  });
  it("ignores whitespace and key order in JSON text fields", () => {
    const form = draftFormFromSuggestion(SUGGESTION);
    form.fixedParams = '{"granularity":"month",   "metric":"revenue"}';
    expect(hasEdits(diffAgainstSuggestion(form, SUGGESTION))).toBe(false);
  });
  it("flags an edited field with the suggested text alongside", () => {
    const form = { ...draftFormFromSuggestion(SUGGESTION), description: "Monthly sales heatmap" };
    const diff = diffAgainstSuggestion(form, SUGGESTION);
    const changed = diff.filter((d) => d.changed);
    expect(changed).toEqual([
      {
        field: "description",
        suggested: "Display sales as a monthly calendar heatmap",
        current: "Monthly sales heatmap",
        changed: true,
      },
    ]);
    expect(hasEdits(diff)).toBe(true);
  });
  it("treats invalid JSON text as changed (it cannot equal the suggestion)", () => {
    const form = { ...draftFormFromSuggestion(SUGGESTION), paramMap: "{not json" };
    expect(diffAgainstSuggestion(form, SUGGESTION).find((d) => d.field === "paramMap")!.changed).toBe(true);
  });
});

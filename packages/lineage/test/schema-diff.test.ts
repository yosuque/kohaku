import { describe, expect, it } from "vitest";
import { type ComponentDraft, diffDraft } from "../src/index.js";

const SUGGESTED: ComponentDraft = {
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
};

describe("diffDraft (field-level diff between the suggested draft and the human-submitted draft)", () => {
  it("reports every field as unchanged for an identical draft", () => {
    const diff = diffDraft(SUGGESTED, { ...SUGGESTED });
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toEqual([
      "componentType",
      "version",
      "intentName",
      "description",
      "paramsJsonSchema",
      "queryTemplate",
    ]);
  });

  it("ignores JSON key order when comparing object fields (canonical JSON)", () => {
    const reordered: ComponentDraft = {
      ...SUGGESTED,
      queryTemplate: {
        paramMap: { fiscalYear: "fy" },
        fixedParams: { granularity: "month", metric: "revenue" },
        path: "trend",
      },
    };
    expect(diffDraft(SUGGESTED, reordered).changed).toEqual([]);
  });

  it("lists a changed field with both values, in the fixed field order", () => {
    const edited: ComponentDraft = {
      ...SUGGESTED,
      description: "Monthly sales heatmap",
      queryTemplate: undefined,
    };
    const diff = diffDraft(SUGGESTED, edited);
    expect(diff.changed).toEqual([
      { field: "description", suggested: SUGGESTED.description, final: "Monthly sales heatmap" },
      { field: "queryTemplate", suggested: SUGGESTED.queryTemplate, final: undefined },
    ]);
    expect(diff.unchanged).toEqual(["componentType", "version", "intentName", "paramsJsonSchema"]);
  });

  it("treats an absent optional field on both sides as unchanged", () => {
    const a: ComponentDraft = { componentType: "x.y", version: "1.0.0", intentName: "x.y", description: "d" };
    const diff = diffDraft(a, { ...a });
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toContain("paramsJsonSchema");
  });
});

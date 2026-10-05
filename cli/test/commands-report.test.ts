import { describe, expect, it } from "vitest";
import { formatDatasetExportResult, formatSmokeL2Output } from "../src/commands.js";

describe("formatDatasetExportResult", () => {
  it("sums fixations and golden records and reports the skipped count and output path", () => {
    expect(
      formatDatasetExportResult({ fixations: 3, golden: 2, skipped: 1, outPath: "/out/data.jsonl" }),
    ).toBe("Wrote 5 record(s) (fixations=3, golden=2, skipped=1) to /out/data.jsonl");
  });
});

describe("formatSmokeL2Output", () => {
  it("is one JSON line terminated by a newline", () => {
    expect(formatSmokeL2Output({ issues: [] })).toBe('{"issues":[]}\n');
    expect(formatSmokeL2Output({ issues: ["a", "b"] })).toBe('{"issues":["a","b"]}\n');
  });
});

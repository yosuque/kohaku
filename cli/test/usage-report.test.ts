import { describe, expect, it } from "vitest";
import type { UsageExportResult } from "../src/usage/index.js";
import { formatUsageExportResult } from "../src/usage/report.js";

function result(overrides: Partial<UsageExportResult>): UsageExportResult {
  return { rows: [], text: "", skippedLines: 0, ...overrides };
}

describe("formatUsageExportResult", () => {
  it("returns the rendered text unchanged when nothing was written to a file", () => {
    const text = "date,tenant\n2026-10-01,acme\n";
    expect(formatUsageExportResult(result({ text }))).toBe(text);
  });

  it("returns the file notice without a trailing newline when --out was given", () => {
    const rows = [{}, {}, {}] as UsageExportResult["rows"];
    expect(formatUsageExportResult(result({ rows, text: "ignored\n", outPath: "/out/usage.csv" }))).toBe(
      "Wrote 3 usage row(s) to /out/usage.csv",
    );
  });
});

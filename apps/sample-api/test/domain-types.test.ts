import { describe, expect, it } from "vitest";
import { SalesRepo } from "../src/domain/repo.js";
import { fiscalYearOf, quarterOf } from "../src/domain/types.js";

// Invariant: fiscalYearOf/quarterOf (the single source scripts/generate-seed.ts and
// ports/semantic-port.ts both draw from) must agree with every seed record's own fiscalYear/quarter,
// derived independently from its calendar month string. This is the cross-check that would catch a
// regeneration bug or a helper/seed convention drift (generate-seed.ts computes fiscalYear directly
// rather than via fiscalYearOf — see that file's fiscalMonth doc — so this test is the only place the
// two directions are checked against each other).
describe("fiscalYearOf / quarterOf against the seed (576 records)", () => {
  const repo = new SalesRepo();

  it("the seed has the expected row count (2 fiscal years x 12 months x 4 regions x 6 products)", () => {
    expect(repo.records).toHaveLength(576);
  });

  it("every record's fiscalYear/quarter matches fiscalYearOf/quarterOf of its own calendar month", () => {
    expect(repo.records.length).toBeGreaterThan(0);
    for (const r of repo.records) {
      const [calYearStr, calMonthStr] = r.month.split("-");
      const calYear = Number(calYearStr);
      const calMonth = Number(calMonthStr);
      expect(fiscalYearOf(calYear, calMonth)).toBe(r.fiscalYear);
      expect(quarterOf(calMonth)).toBe(r.quarter);
    }
  });

  it("fiscalYearOf/quarterOf boundary values (Mar 31 -> prior FY Q4, Apr 1 -> this FY Q1)", () => {
    expect(fiscalYearOf(2026, 3)).toBe(2025);
    expect(quarterOf(3)).toBe(4);
    expect(fiscalYearOf(2026, 4)).toBe(2026);
    expect(quarterOf(4)).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import { formatMigrateApplyResult, formatMigratePlanResult, type MigratePlanResult } from "../src/migrate.js";

type ApplyResult = Parameters<typeof formatMigrateApplyResult>[0];

function planResult(plan: Record<string, unknown>): MigratePlanResult {
  return {
    outPath: "/out/plan.json",
    plan: {
      planHash: "sha256:abc",
      rewrites: [],
      steps: [],
      blocked: [],
      ...plan,
    } as unknown as MigratePlanResult["plan"],
  };
}

describe("formatMigratePlanResult", () => {
  it("prints (none) when there are no rewrites and omits the blocked block", () => {
    expect(formatMigratePlanResult(planResult({}))).toBe(
      [
        "Wrote /out/plan.json (planHash: sha256:abc)",
        "  rewrites: (none)",
        "  steps: 0 fixation(s) ready to apply",
      ].join("\n"),
    );
  });

  it("lists rewrites, the step count and every blocked fixation (with an optional tenant)", () => {
    const text = formatMigratePlanResult(
      planResult({
        rewrites: [
          { from: "sales.legacyList", to: { type: "core.list" } },
          { from: "sales.oldChart", to: { type: "core.chart" } },
        ],
        steps: [{}, {}, {}],
        blocked: [
          { intentHash: "sha256:1", issues: ["i1", "i2"] },
          { intentHash: "sha256:2", tenant: "acme", issues: ["i3"] },
        ],
      }),
    );
    expect(text).toBe(
      [
        "Wrote /out/plan.json (planHash: sha256:abc)",
        "  rewrites: sales.legacyList -> core.list, sales.oldChart -> core.chart",
        "  steps: 3 fixation(s) ready to apply",
        "  blocked: 2 fixation(s) failed revalidation and need manual attention:",
        "    - sha256:1: i1; i2",
        "    - sha256:2 (tenant: acme): i3",
      ].join("\n"),
    );
  });
});

describe("formatMigrateApplyResult", () => {
  it("prints only the tally when nothing happened", () => {
    expect(
      formatMigrateApplyResult({ applied: [], skipped: [], blocked: [] } as unknown as ApplyResult),
    ).toBe("Applied 0, skipped 0, blocked 0");
  });

  it("prints applied, skipped and blocked steps in that order, with optional tenants and issues", () => {
    const result = {
      applied: [{ intentHash: "sha256:a" }, { intentHash: "sha256:b", tenant: "acme" }],
      skipped: [{ intentHash: "sha256:c", tenant: "beta" }],
      blocked: [
        { intentHash: "sha256:d", observedCatalogFingerprint: "fp1", issues: [] },
        { intentHash: "sha256:e", tenant: "acme", observedCatalogFingerprint: "fp2", issues: ["x", "y"] },
      ],
    } as unknown as ApplyResult;
    expect(formatMigrateApplyResult(result)).toBe(
      [
        "Applied 2, skipped 1, blocked 2",
        "  applied: sha256:a",
        "  applied: sha256:b (tenant: acme)",
        "  skipped: sha256:c (tenant: beta) (fixation changed since the plan was computed)",
        "  blocked: sha256:d (catalog drift — live fingerprint fp1)",
        "  blocked: sha256:e (tenant: acme) (catalog drift — live fingerprint fp2; x; y)",
      ].join("\n"),
    );
  });
});

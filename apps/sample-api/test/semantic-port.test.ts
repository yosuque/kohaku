import type { GenerateObjectRequest, LlmPort } from "@kohaku-ui/llm";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { buildNormalizeSystemPrompt } from "@kohaku-ui/semantic-llm";
import type { SessionContext } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { SalesRepo } from "../src/domain/repo.js";
import { createSalesIntentCatalog } from "../src/intents/catalog.js";
import { createSemanticPort, fiscalPeriodOf } from "../src/ports/semantic-port.js";

// Provider-error vs fallback-mismatch classification for normalizeNl (thrown vs. degraded to sales.custom) now
// lives in @kohaku-ui/semantic-llm's own test suite (packages/semantic-llm/test/nl.test.ts), since that behavior
// moved into createLlmSemanticPort in Task 2. What remains sample-api-specific: the sales rules (fiscal calendar,
// region normalization, the sales.custom escape hatch) injected into the shared prompt, and their runtime
// computation from an injectable clock.

const CTX: SessionContext = { surface: "web", locale: "ja" };

// Regression for computing fiscal periods like 「今四半期」 at runtime from the clock instead of hardcoding them (a staleness bugfix).
// The FY starts in April: Q1=Apr-Jun / Q2=Jul-Sep / Q3=Oct-Dec / Q4=Jan-Mar (the convention in domain/types.ts).
describe("fiscalPeriodOf (April-start fiscal period calculation)", () => {
  it.each<[string, Date, number, number]>([
    // Quarter boundary: 6/30 is the last day of Q1, Q2 from 7/1.
    ["2026-06-30", new Date(2026, 5, 30), 2026, 1],
    ["2026-07-01", new Date(2026, 6, 1), 2026, 2],
    ["2026-09-30", new Date(2026, 8, 30), 2026, 2],
    ["2026-10-01", new Date(2026, 9, 1), 2026, 3],
    // Fiscal-year boundary: even across the calendar year, up to 3/31 is FY2026 (Q4), and FY2027 (Q1) from 4/1.
    ["2027-01-15", new Date(2027, 0, 15), 2026, 4],
    ["2027-03-31", new Date(2027, 2, 31), 2026, 4],
    ["2027-04-01", new Date(2027, 3, 1), 2027, 1],
  ])("%s → FY%i Q%i", (_name, date, fy, q) => {
    const p = fiscalPeriodOf(date);
    expect(p.fiscalYear).toBe(fy);
    expect(p.quarter).toBe(q);
  });
});

/** A stub that captures the generateObject request (the system prompt) and returns a fixed response. */
function capturingLlm(captured: { system?: string }): LlmPort {
  return {
    provider: "stub",
    modelId: "stub",
    async generateObject<T>(req: GenerateObjectRequest<T>) {
      captured.system = req.system;
      return {
        object: { intent: "sales.kpi_overview", params: {} } as T,
        usage: { inputTokens: 0, outputTokens: 0 },
        model: "stub",
      };
    },
    async generateText() {
      return { text: "", usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

describe("the fiscal period in the NL normalization prompt (determinized via clock injection)", () => {
  async function systemPromptAt(now: Date): Promise<string> {
    const captured: { system?: string } = {};
    const catalog = createSalesIntentCatalog();
    const port = createSemanticPort({
      repo: new SalesRepo(),
      catalogFor: () => catalog,
      llm: capturingLlm(captured),
      now: () => now,
    });
    await port.normalize({ kind: "nl", text: "今四半期のサマリー" }, CTX);
    expect(captured.system).toBeDefined();
    return captured.system!;
  }

  it("2026-07-12 (FY2026 Q2) carries current quarter=2, current fiscal year=2026, prior year=2025", async () => {
    const system = await systemPromptAt(new Date(2026, 6, 12));
    expect(system).toContain('"this period"/"this fiscal year" (今期/今年度) = fiscalYear=2026');
    expect(system).toContain('"this quarter" (今四半期) = quarter=2 (now 2026-7)');
    expect(system).toContain("FY2026 = 2026-04 to 2027-03");
    expect(system).toContain('"last year"/"prior fiscal year" (前年/昨年度) = fiscalYear=2025');
  });

  it("quarter boundary: 6/30 is quarter=1, 7/1 becomes quarter=2", async () => {
    expect(await systemPromptAt(new Date(2026, 5, 30))).toContain(
      '"this quarter" (今四半期) = quarter=1 (now 2026-6)',
    );
    expect(await systemPromptAt(new Date(2026, 6, 1))).toContain(
      '"this quarter" (今四半期) = quarter=2 (now 2026-7)',
    );
  });

  it("fiscal-year boundary: 2027-01 (calendar year is the next year) still keeps current fiscal year=2026, current quarter=4", async () => {
    const system = await systemPromptAt(new Date(2027, 0, 15));
    expect(system).toContain('"this period"/"this fiscal year" (今期/今年度) = fiscalYear=2026');
    expect(system).toContain('"this quarter" (今四半期) = quarter=4 (now 2027-1)');
    expect(system).toContain('"last year"/"prior fiscal year" (前年/昨年度) = fiscalYear=2025');
  });

  // Fiscal-year clamp: even if the actual time exceeds the seed range (FY2025-FY2026), a nonexistent year is
  // not injected into the prompt (rounded to vocab's FISCAL_YEAR_MAX). Consistent with the time-independent seed (#time).
  it("out of range: 2027-04 (FY2027) still clamps current fiscal year to 2026, prior year to 2025", async () => {
    const system = await systemPromptAt(new Date(2027, 3, 1));
    // fiscalYear=2027 does not exist, so it is not injected (distinguished from the FY label / the "2027" in the current year-month notation).
    expect(system).not.toContain("fiscalYear=2027");
    expect(system).toContain('"this period"/"this fiscal year" (今期/今年度) = fiscalYear=2026');
    expect(system).toContain("FY2026 = 2026-04 to 2027-03");
    expect(system).toContain('"last year"/"prior fiscal year" (前年/昨年度) = fiscalYear=2025');
    // The current calendar year-month (informational display) is not rounded and stays at the actual time. Q1 (Apr-Jun) = quarter=1.
    expect(system).toContain('"this quarter" (今四半期) = quarter=1 (now 2027-4)');
  });
});

describe("sales rules in the normalization prompt", () => {
  it("renders the fiscal-year / region / custom rules from the injected clock, in the historical order", async () => {
    const llm = new FakeLlm({ objects: [{ intent: "sales.trend", params: {} }] });
    const catalog = createSalesIntentCatalog();
    const port = createSemanticPort({
      repo: new SalesRepo(),
      catalogFor: () => catalog,
      llm,
      now: () => new Date("2026-05-15T00:00:00Z"),
    });
    await port.normalize({ kind: "nl", text: "trend" }, { surface: "web", locale: "en" });
    expect(llm.calls[0]!.system).toBe(
      buildNormalizeSystemPrompt([
        '- The fiscal year starts in April (FY2026 = 2026-04 to 2027-03). "this period"/"this fiscal year" (今期/今年度) = fiscalYear=2026; "this quarter" (今四半期) = quarter=1 (now 2026-5).',
        '- "last year"/"prior fiscal year" (前年/昨年度) = fiscalYear=2025',
        "- Normalize region names to japan / north_america / europe / apac (日本→japan, 北米→north_america, 欧州/ヨーロッパ→europe, アジア太平洋→apac)",
        "- For a visualization request that fits no Intent (a heatmap, matrix, or other bespoke form), choose sales.custom and put the original request text verbatim into params.request",
      ]),
    );
    expect(llm.calls[0]!.prompt).toContain("## User question (en)");
  });
});

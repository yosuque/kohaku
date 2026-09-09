import { type GenerateObjectRequest, LlmError, type LlmErrorCode, type LlmPort } from "@kohaku-ui/llm";
import type { SessionContext } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { SalesRepo } from "../src/domain/repo.js";
import { IntentCatalog } from "../src/intents/catalog.js";
import { createSemanticPort, fiscalPeriodOf } from "../src/ports/semantic-port.js";

// Provider-error vs fallback-mismatch classification for normalizeNl.
// Falling back to custom is limited to the "normal response but does not fit any intent" case; provider failures, cancellation,
// and misconfiguration are not swallowed but thrown (so the upstream composer can return SEMANTIC_FAILED -> COMPOSE_FAILED).
// No LLM is used; LlmPort is stubbed directly (scripted responses / exception injection only).

const CTX: SessionContext = { surface: "web", locale: "ja" };

function makePort(llm: LlmPort) {
  const catalog = new IntentCatalog();
  return createSemanticPort({ repo: new SalesRepo(), catalogFor: () => catalog, llm });
}

/** A stub whose generateObject always throws an LlmError with the specified code. */
function throwingLlm(code: LlmErrorCode): LlmPort {
  return {
    provider: "stub",
    modelId: "stub",
    async generateObject() {
      throw new LlmError(code, `stub ${code}`);
    },
    async generateText() {
      throw new LlmError(code, `stub ${code}`);
    },
  };
}

/** A stub whose generateObject returns a fixed object (does not validate the output schema). */
function fixedLlm(object: unknown): LlmPort {
  return {
    provider: "stub",
    modelId: "stub",
    async generateObject<T>() {
      return { object: object as T, usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" };
    },
    async generateText() {
      return { text: "", usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

describe("normalizeNl error classification", () => {
  it("a PROVIDER failure is thrown rather than swallowed", async () => {
    const port = makePort(throwingLlm("PROVIDER"));
    await expect(port.normalize({ kind: "nl", text: "売上を見せて" }, CTX)).rejects.toBeInstanceOf(LlmError);
  });

  it("ABORTED (cancellation) is also thrown", async () => {
    const port = makePort(throwingLlm("ABORTED"));
    await expect(port.normalize({ kind: "nl", text: "売上を見せて" }, CTX)).rejects.toBeInstanceOf(LlmError);
  });

  it("CONFIG (misconfiguration) is also thrown", async () => {
    const port = makePort(throwingLlm("CONFIG"));
    await expect(port.normalize({ kind: "nl", text: "売上を見せて" }, CTX)).rejects.toBeInstanceOf(LlmError);
  });

  it("INVALID_OUTPUT (response present but inconsistent) degrades to sales.custom", async () => {
    const port = makePort(throwingLlm("INVALID_OUTPUT"));
    const out = await port.normalize({ kind: "nl", text: "売上をカレンダーヒートマップで" }, CTX);
    expect(out.canonical).toBe("sales.custom");
    expect((out.params as { request?: string }).request).toBe("売上をカレンダーヒートマップで");
  });

  it("a normal response that fails params validation degrades to sales.custom", async () => {
    // request missing -> normalizeParams("sales.custom", {}) is null -> to the explicit fallback.
    const port = makePort(fixedLlm({ intent: "sales.custom", params: {} }));
    const out = await port.normalize({ kind: "nl", text: "自由な可視化" }, CTX);
    expect(out.canonical).toBe("sales.custom");
    expect((out.params as { request?: string }).request).toBe("自由な可視化");
  });

  it("a normal response matching a known Intent returns it (happy path)", async () => {
    const port = makePort(fixedLlm({ intent: "sales.trend", params: { metric: "units" } }));
    const out = await port.normalize({ kind: "nl", text: "販売数の推移" }, CTX);
    expect(out.canonical).toBe("sales.trend");
    expect((out.params as { metric?: string }).metric).toBe("units");
  });
});

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
    const catalog = new IntentCatalog();
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

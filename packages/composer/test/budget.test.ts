import type { GenerateObjectResult, LlmPort, LlmUsage } from "@kohaku-ui/llm";
import { LlmError } from "@kohaku-ui/llm";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { type GuiAction, SANDBOX_HTML_TYPE } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import {
  type BudgetCheckErrorContext,
  type ComposeContext,
  type ComposeErrorContext,
  checkBudget,
  compose,
  composeStream,
} from "../src/index.js";
import { catalog, goodRawDraft, makeSemantic, makeStorage } from "./helpers.js";

const GUI_INPUT: GuiAction = {
  kind: "gui",
  action: "facet.change",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
};

function makeCtx(llm: LlmPort, policy: ComposeContext["policy"] = {}): ComposeContext {
  return { catalog, semantic: makeSemantic(), storage: makeStorage(), llm, policy };
}

/** An LlmPort stub that lets usage be swapped per response and exposes the call count (for verifying perCompose accumulation). */
function makeUsageLlm(objects: unknown[], usages: LlmUsage[]): { llm: LlmPort; callCount: () => number } {
  let calls = 0;
  let idx = 0;
  const llm: LlmPort = {
    provider: "usage",
    modelId: "usage-model",
    async generateObject<T>(): Promise<GenerateObjectResult<T>> {
      calls += 1;
      const object = objects[idx];
      if (object === undefined) throw new LlmError("INVALID_OUTPUT", "usage stub: responses exhausted");
      const usage = usages[idx] ?? { inputTokens: 0, outputTokens: 0 };
      idx += 1;
      return { object: object as T, usage, model: "usage-model" };
    },
    async generateText() {
      throw new Error("usage stub: generateText not supported");
    },
  };
  return { llm, callCount: () => calls };
}

const BAD = { components: [], events: [] }; // empty components = catalog/structural-validation failure (repair-target invalid)

describe("compose: budget guard perCompose", () => {
  it("on perCompose overage, skips the repair retry and falls to the deterministic fallback", async () => {
    // The first attempt (usage 120) fails validation → the pre-repair budget check has 120 >= 100 → repair is aborted.
    const { llm, callCount } = makeUsageLlm(
      [BAD, goodRawDraft()],
      [
        { inputTokens: 80, outputTokens: 40 },
        { inputTokens: 0, outputTokens: 0 },
      ],
    );
    const { spec, trace } = await compose(
      GUI_INPUT,
      makeCtx(llm, { budget: { perCompose: { stopAfterTokens: 100 } } }),
    );

    // Repair (the good at index 1) is not called = only 1 LLM call
    expect(callCount()).toBe(1);
    expect(trace.attempts).toHaveLength(1);
    expect(trace.attempts[0]!.ok).toBe(false);
    // The deterministic fallback with presentMarkdown (from=L1, kind=generation)
    expect(spec.components.map((c) => c.type)).toEqual(["layout.stack", "presentMarkdown"]);
    expect(spec.provenance.fallback?.from).toBe("L1");
    expect(spec.provenance.fallback?.kind).toBe("generation");
    // reason carries a value from which budget overage can be discerned (both provenance / trace)
    expect(spec.provenance.fallback?.reason).toMatch(/budget exceeded/i);
    expect(trace.fallback?.reason).toMatch(/budget exceeded/i);
  });

  it("perCompose: with stopAfterTokens 0 (zero budget), falls back without calling the LLM at all", async () => {
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    const { spec, trace } = await compose(
      GUI_INPUT,
      makeCtx(llm, { budget: { perCompose: { stopAfterTokens: 0 } } }),
    );

    // Rejected by the check before the initial L1 generation (spent=0 >= 0) → zero generation calls
    expect(llm.calls).toHaveLength(0);
    expect(trace.attempts).toHaveLength(0);
    expect(spec.provenance.fallback?.from).toBe("L1");
    expect(spec.provenance.fallback?.reason).toMatch(/budget exceeded/i);
  });

  it("within perCompose, retries repair and succeeds (invariance within budget)", async () => {
    // FakeLlm's usage is 0, so the accumulation never reaches the cap and the repair loop runs normally.
    const llm = new FakeLlm({ objects: [BAD, goodRawDraft()] });
    const { spec, trace } = await compose(
      GUI_INPUT,
      makeCtx(llm, {
        budget: { perCompose: { stopAfterTokens: 1_000_000 }, check: () => ({ allow: true }) },
      }),
    );

    expect(trace.attempts).toHaveLength(2);
    expect(trace.attempts[0]!.ok).toBe(false);
    expect(trace.attempts[1]!.ok).toBe(true);
    expect(spec.provenance.tier).toBe("L1");
    expect(spec.provenance.fallback).toBeUndefined();
    expect(llm.calls).toHaveLength(2);
  });

  it("succeeds even if the initial LLM call greatly exceeds stopAfterTokens (a single call cannot be pre-suppressed, only detected after the fact)", async () => {
    // Documenting the contract: stopAfterTokens is "a threshold that stops additional calls", not a hard cap on total tokens.
    // The check at attempt 0 passes because spent=0 < 100, and the initial call is executed. Even if that
    // one call consumes 60,000 tokens (600x the threshold of 100), it is not stopped and generation succeeds. The overage is merely recorded after the fact in trace.usage.
    const { llm, callCount } = makeUsageLlm(
      [goodRawDraft()],
      [{ inputTokens: 50_000, outputTokens: 10_000 }],
    );
    const { spec, trace } = await compose(
      GUI_INPUT,
      makeCtx(llm, { budget: { perCompose: { stopAfterTokens: 100 } } }),
    );

    // The initial call passes the check and is executed, and L1 succeeds (no fallback)
    expect(callCount()).toBe(1);
    expect(spec.provenance.tier).toBe("L1");
    expect(spec.provenance.fallback).toBeUndefined();
    // The overage is only visible after the fact via trace.usage (making explicit that it is not a hard cap)
    expect(trace.usage).toEqual({ inputTokens: 50_000, outputTokens: 10_000 });
    expect(trace.usage!.inputTokens + trace.usage!.outputTokens).toBeGreaterThan(100);
  });
});

describe("compose: budget guard check hook", () => {
  type Captured = { ctx: ComposeErrorContext; error: unknown };

  it("a check denial skips the L2 promotion and falls back (budgetExceeded on onError)", async () => {
    // allow before L1 generation and before repair, deny before L2 (the 3rd call). Verifies the call timing (before L1 / before repair / before L2).
    let checkCalls = 0;
    const check = (): { allow: boolean; reason?: string } => {
      checkCalls += 1;
      return checkCalls >= 3 ? { allow: false, reason: "daily budget exhausted(test)" } : { allow: true };
    };
    const captured: Captured[] = [];
    const llm = new FakeLlm({ objects: [BAD, BAD] }); // L1 is invalid on both the initial attempt and repair
    const ctx: ComposeContext = {
      ...makeCtx(llm, { allowL2: true, budget: { check } }),
      observer: {
        onError: (c, error) => {
          captured.push({ ctx: c, error });
        },
      },
    };
    const { spec, trace } = await compose(GUI_INPUT, ctx);

    // check is called 3 times: before L1, before repair, before L2, and skips L2 on the 3rd call
    expect(checkCalls).toBe(3);
    // L2 generation (the 3rd LLM call) is not called
    expect(llm.calls).toHaveLength(2);
    // Since L2 does not run, "the stage that actually failed" is L1
    expect(spec.provenance.tier).toBe("L1");
    expect(spec.provenance.fallback?.from).toBe("L1");
    expect(spec.provenance.fallback?.reason).toContain("daily budget");
    expect(trace.fallback?.reason).toContain("daily budget");
    // Observation: onError (phase:fallback) carries budgetExceeded and the product-supplied reason
    expect(captured).toHaveLength(1);
    expect(captured[0]!.ctx.phase).toBe("fallback");
    expect(captured[0]!.ctx.budgetExceeded).toBe(true);
    expect(captured[0]!.ctx.reason).toContain("daily budget");
  });

  it("with route=L2 direct and zero budget, falls back without calling L2 (from=L2)", async () => {
    const captured: Captured[] = [];
    // With zero budget the LLM is never called (no scripted response needed)
    const llm = new FakeLlm();
    const ctx: ComposeContext = {
      ...makeCtx(llm, {
        allowL2: true,
        routeTier: () => "L2",
        budget: { check: () => ({ allow: false, reason: "tenant budget exceeded(test)" }) },
      }),
      observer: {
        onError: (c, error) => {
          captured.push({ ctx: c, error });
        },
      },
    };
    const { spec } = await compose(GUI_INPUT, ctx);

    // L1 is skipped due to route=L2, and L2 is not called due to the budget check → zero LLM calls
    expect(llm.calls).toHaveLength(0);
    expect(spec.provenance.tier).toBe("L2");
    expect(spec.provenance.fallback?.from).toBe("L2");
    expect(spec.provenance.fallback?.reason).toContain("tenant budget");
    expect(captured[0]!.ctx.budgetExceeded).toBe(true);
    expect(captured[0]!.ctx.tier).toBe("L2");
  });

  it("a throw in check is swallowed and passed through (generation continues)", async () => {
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    const { spec } = await compose(
      GUI_INPUT,
      makeCtx(llm, {
        budget: {
          check: () => {
            throw new Error("error inside budget hook(test)");
          },
        },
      }),
    );

    // Even if the hook is broken, do not drop every UI to a fallback (fail-open). See a separate test for the not-left-unobserved verification.
    expect(spec.provenance.tier).toBe("L1");
    expect(spec.provenance.fallback).toBeUndefined();
    expect(llm.calls).toHaveLength(1);
  });

  it("a throw in check continues generation fail-open while being observable via onBudgetCheckError", async () => {
    // Do not leave the fail-open unobserved: the throw is swallowed, but the occurrence is forwarded to observer.onBudgetCheckError.
    const captured: { ctx: BudgetCheckErrorContext; error: unknown }[] = [];
    const boom = new Error("error inside budget hook(test)");
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    const ctx: ComposeContext = {
      ...makeCtx(llm, {
        budget: {
          check: () => {
            throw boom;
          },
        },
      }),
      observer: {
        onBudgetCheckError: (c, error) => {
          captured.push({ ctx: c, error });
        },
      },
    };
    const { spec } = await compose(GUI_INPUT, ctx);

    // Generation continues and succeeds at L1 (does not appear on onError — this is not a failure)
    expect(spec.provenance.tier).toBe("L1");
    expect(spec.provenance.fallback).toBeUndefined();
    expect(llm.calls).toHaveLength(1);
    // Observation: fires exactly once before L1 generation, and the causing exception and tier arrive in a machine-distinguishable form
    expect(captured).toHaveLength(1);
    expect(captured[0]!.ctx.tier).toBe("L1");
    expect(captured[0]!.error).toBe(boom);
  });

  it("even when L1 is invalid, if budget allows it promotes to L2 (happy-path invariance)", async () => {
    const L2_TEXT =
      "<!DOCTYPE html><html><head><title>Sales widget</title></head><body><script>window.kohaku.ready()</script></body></html>";
    const llm = new FakeLlm({ objects: [BAD, BAD], texts: [L2_TEXT] });
    const { spec } = await compose(
      GUI_INPUT,
      makeCtx(llm, { allowL2: true, budget: { check: () => ({ allow: true }) } }),
    );

    // Budget always allows → 3 calls: L1 initial + repair + L2, promoting to L2 and producing the sandbox component
    expect(spec.provenance.tier).toBe("L2");
    expect(spec.components.some((c) => c.type === SANDBOX_HTML_TYPE)).toBe(true);
    expect(llm.calls).toHaveLength(3);
  });
});

describe("compose: budget guard backward compatibility", () => {
  it("when budget is unspecified, both the repair loop and fallback behave normally (behavior unchanged)", async () => {
    const llm = new FakeLlm({ objects: [BAD, goodRawDraft()] });
    const { spec, trace } = await compose(GUI_INPUT, makeCtx(llm));

    expect(trace.attempts).toHaveLength(2);
    expect(spec.provenance.tier).toBe("L1");
    expect(spec.provenance.fallback).toBeUndefined();
  });
});

describe("checkBudget: decision priority and fail-open forwarding (unit)", () => {
  it("on perCompose overage, does not call check (perCompose-priority short-circuit)", () => {
    // Coexist a check that throws: if check were evaluated, fail-open would flip it to allow:true, so
    // returning allow:false is itself evidence that "check was not called". Double-check via the call count too.
    let checkCalls = 0;
    const verdict = checkBudget(
      {
        perCompose: { stopAfterTokens: 100 },
        check: () => {
          checkCalls += 1;
          throw new Error("perCompose should not be evaluated when exceeded");
        },
      },
      150, // spent 150 >= threshold 100
    );

    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toMatch(/budget exceeded/i);
    expect(checkCalls).toBe(0);
  });

  it("a throw in check falls to allow while forwarding the causing exception to onCheckError (fail-open observation point)", () => {
    const boom = new Error("hook failure");
    let received: unknown;
    const verdict = checkBudget(
      {
        check: () => {
          throw boom;
        },
      },
      0,
      (error) => {
        received = error;
      },
    );

    // fail-open: generation is passed through (allow). But the occurrence is forwarded to onCheckError (not left unobserved).
    expect(verdict.allow).toBe(true);
    expect(received).toBe(boom);
  });
});

describe("composeStream: budget guard", () => {
  it("a zero-budget downgrade flows as skeleton → fallback patch (no LLM call)", async () => {
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    const events = [];
    for await (const ev of composeStream(
      GUI_INPUT,
      makeCtx(llm, { budget: { perCompose: { stopAfterTokens: 0 } } }),
    )) {
      events.push(ev);
    }

    // The LLM is not called, and it flows in the order skeleton (final:false) → patch → done
    expect(llm.calls).toHaveLength(0);
    expect(events.map((e) => e.kind)).toEqual(["spec", "patch", "done"]);
    const first = events[0]!;
    expect(first.kind === "spec" && first.final).toBe(false);
    const patch = events[1]!;
    if (patch.kind === "patch") expect(patch.spec.provenance.fallback?.from).toBe("L1");
    const done = events[2]!;
    if (done.kind === "done") {
      expect(done.result.spec.provenance.fallback?.reason).toMatch(/budget exceeded/i);
    }
  });
});

import type { GenerateObjectRequest, GenerateObjectResult, LlmPort } from "@kohaku-ui/llm";
import { LlmError } from "@kohaku-ui/llm";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { GuiAction } from "@kohaku-ui/spec-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ComposeContext,
  type ComposeErrorContext,
  checkBudget,
  compose,
  composeStream,
  createDeadlineGuard,
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

const BAD = { components: [], events: [] }; // empty components = catalog/structural-validation failure (repair-target invalid)

afterEach(() => {
  // Guard against a fake-timer test leaking its clock into a later test.
  vi.useRealTimers();
});

describe("checkBudget: deadline (unit)", () => {
  it("allows when elapsed is below the deadline", () => {
    const verdict = checkBudget({ deadlineMs: 1000 }, 0, undefined, 500);
    expect(verdict.allow).toBe(true);
  });

  it("rejects with a deadline-specific reason once elapsed reaches the deadline", () => {
    const verdict = checkBudget({ deadlineMs: 1000 }, 0, undefined, 1000);
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toMatch(/budget exceeded/i);
    expect(verdict.reason).toMatch(/deadline/i);
  });

  it("the deadline reason is distinguishable from the token-threshold reason", () => {
    const tokenVerdict = checkBudget({ perCompose: { stopAfterTokens: 10 } }, 10);
    const deadlineVerdict = checkBudget({ deadlineMs: 1000 }, 0, undefined, 1000);
    expect(tokenVerdict.reason).not.toEqual(deadlineVerdict.reason);
    expect(tokenVerdict.reason).toMatch(/token threshold/i);
    expect(deadlineVerdict.reason).not.toMatch(/token threshold/i);
  });

  it("does not check the deadline when elapsedMs is not supplied (caller opted out of measuring it)", () => {
    const verdict = checkBudget({ deadlineMs: 0 }, 0, undefined, undefined);
    expect(verdict.allow).toBe(true);
  });

  it("does not check the deadline when deadlineMs is unset, regardless of elapsedMs", () => {
    const verdict = checkBudget({}, 0, undefined, 999_999);
    expect(verdict.allow).toBe(true);
  });

  it("a simultaneous token-threshold overage takes precedence over a deadline overage (perCompose is checked first)", () => {
    const verdict = checkBudget(
      { perCompose: { stopAfterTokens: 10 }, deadlineMs: 1000 },
      10,
      undefined,
      2000,
    );
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toMatch(/token threshold/i);
  });
});

describe("createDeadlineGuard (unit)", () => {
  it("when budget.deadlineMs is unset, returns the caller's signal unchanged (same reference) and a no-op disposer", () => {
    const controller = new AbortController();
    const guard = createDeadlineGuard(undefined, Date.now(), controller.signal);
    expect(guard.signal).toBe(controller.signal);
    expect(guard.deadlineSignal).toBeUndefined();
    expect(() => guard.dispose()).not.toThrow();
  });

  it("when budget is set but deadlineMs is unset, still passes the caller's signal through unchanged", () => {
    const controller = new AbortController();
    const guard = createDeadlineGuard(
      { perCompose: { stopAfterTokens: 100 } },
      Date.now(),
      controller.signal,
    );
    expect(guard.signal).toBe(controller.signal);
    expect(guard.deadlineSignal).toBeUndefined();
  });

  it("when deadlineMs is set and no caller signal is given, signal and deadlineSignal are the same fresh AbortSignal", () => {
    const guard = createDeadlineGuard({ deadlineMs: 1000 }, Date.now(), undefined);
    try {
      expect(guard.signal).toBeDefined();
      expect(guard.signal).toBe(guard.deadlineSignal);
      expect(guard.signal?.aborted).toBe(false);
    } finally {
      guard.dispose();
    }
  });

  it("the timer fires (aborting deadlineSignal) once the remaining time elapses", async () => {
    const guard = createDeadlineGuard({ deadlineMs: 10 }, Date.now(), undefined);
    try {
      await new Promise<void>((resolve) => {
        guard.deadlineSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      expect(guard.deadlineSignal?.aborted).toBe(true);
    } finally {
      guard.dispose();
    }
  });

  it("computes the remaining time from the injectable clock (now), not real Date.now()", async () => {
    // On the injected clock, startedAt is already 5000ms in the past and deadlineMs is 5000, so the
    // remaining time is clamped to 0 and the timer must fire almost immediately in real time — proving
    // remainingMs is derived from `now`, not from real wall-clock elapsed time (which is ~0ms here).
    const startedAt = 1_000_000;
    const now = (): number => startedAt + 5_000;
    const guard = createDeadlineGuard({ deadlineMs: 5_000 }, startedAt, undefined, now);
    try {
      await new Promise<void>((resolve) => {
        guard.deadlineSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      expect(guard.deadlineSignal?.aborted).toBe(true);
    } finally {
      guard.dispose();
    }
  });

  it("dispose() clears the timer so it never fires afterward", async () => {
    const guard = createDeadlineGuard({ deadlineMs: 5 }, Date.now(), undefined);
    guard.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(guard.deadlineSignal?.aborted).toBe(false);
  });
});

describe("compose: deadline guard backward compatibility", () => {
  it("when budget is unspecified, behavior is unchanged (no deadline check performed)", async () => {
    const llm = new FakeLlm({ objects: [BAD, goodRawDraft()] });
    const { spec, trace } = await compose(GUI_INPUT, makeCtx(llm));

    expect(trace.attempts).toHaveLength(2);
    expect(spec.provenance.tier).toBe("L1");
    expect(spec.provenance.fallback).toBeUndefined();
  });

  it("when budget.deadlineMs is unspecified but other budget fields are set, deadline checking stays off", async () => {
    const llm = new FakeLlm({ objects: [BAD, goodRawDraft()] });
    const { spec, trace } = await compose(
      GUI_INPUT,
      makeCtx(llm, { budget: { perCompose: { stopAfterTokens: 1_000_000 } } }),
    );

    expect(trace.attempts).toHaveLength(2);
    expect(spec.provenance.tier).toBe("L1");
    expect(spec.provenance.fallback).toBeUndefined();
  });

  it("a generous deadlineMs never trips during a normal fast compose (no false positive)", async () => {
    const llm = new FakeLlm({ objects: [BAD, goodRawDraft()] });
    const { spec, trace } = await compose(GUI_INPUT, makeCtx(llm, { budget: { deadlineMs: 60_000 } }));

    expect(trace.attempts).toHaveLength(2);
    expect(spec.provenance.tier).toBe("L1");
    expect(spec.provenance.fallback).toBeUndefined();
  });
});

describe("compose: deadline guard between-call enforcement", () => {
  it("deadlineMs: 0 falls back without calling the LLM at all (mirrors perCompose's zero-budget behavior)", async () => {
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    const { spec, trace } = await compose(GUI_INPUT, makeCtx(llm, { budget: { deadlineMs: 0 } }));

    expect(llm.calls).toHaveLength(0);
    expect(trace.attempts).toHaveLength(0);
    expect(spec.provenance.fallback?.from).toBe("L1");
    expect(spec.provenance.fallback?.reason).toMatch(/budget exceeded/i);
    expect(spec.provenance.fallback?.reason).toMatch(/deadline/i);
    // A between-call deadline skip is a budget-guard downgrade, not a caller cancellation.
    expect(trace.cancelled).toBeUndefined();
  });

  it("deadlineMs: 0 with route=L2 direct entry falls back without calling L2 either (from=L2)", async () => {
    const llm = new FakeLlm();
    const { spec } = await compose(
      GUI_INPUT,
      makeCtx(llm, { allowL2: true, routeTier: () => "L2", budget: { deadlineMs: 0 } }),
    );

    expect(llm.calls).toHaveLength(0);
    expect(spec.provenance.tier).toBe("L2");
    expect(spec.provenance.fallback?.from).toBe("L2");
    expect(spec.provenance.fallback?.reason).toMatch(/deadline/i);
  });

  it("observer.onError receives budgetExceeded:true (fallback phase, not cancelled) for a between-call deadline skip", async () => {
    const captured: ComposeErrorContext[] = [];
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    const ctx: ComposeContext = {
      ...makeCtx(llm, { budget: { deadlineMs: 0 } }),
      observer: {
        onError: (c) => {
          captured.push(c);
        },
      },
    };
    await compose(GUI_INPUT, ctx);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.phase).toBe("fallback");
    expect(captured[0]!.budgetExceeded).toBe(true);
    expect(captured[0]!.reason).toMatch(/deadline/i);
  });

  it("deadline exceeded between the initial attempt and repair skips the repair retry and falls back", async () => {
    // A custom LlmPort that advances a fake clock past the deadline while "in" its own call, so the
    // between-call check ahead of the repair attempt sees an elapsed time past budget.deadlineMs — this
    // is a deterministic stand-in for real wall-clock time elapsing during a real network call.
    vi.useFakeTimers();
    let calls = 0;
    const llm: LlmPort = {
      provider: "clock",
      modelId: "clock-model",
      async generateObject<T>(): Promise<GenerateObjectResult<T>> {
        calls += 1;
        vi.advanceTimersByTime(60); // exceeds the 50ms deadline before the next attempt's check runs
        return { object: BAD as T, usage: { inputTokens: 0, outputTokens: 0 }, model: "clock-model" };
      },
      async generateText() {
        throw new Error("clock stub: generateText not supported");
      },
    };

    const { spec, trace } = await compose(GUI_INPUT, makeCtx(llm, { budget: { deadlineMs: 50 } }));

    // Only the initial attempt ran; the repair re-attempt was skipped by the between-call deadline check.
    expect(calls).toBe(1);
    expect(trace.attempts).toHaveLength(1);
    expect(spec.provenance.fallback?.from).toBe("L1");
    expect(spec.provenance.fallback?.reason).toMatch(/deadline/i);
    expect(trace.cancelled).toBeUndefined();
  });
});

/** An LlmPort whose generateObject only ever settles when its req.abort signal fires (rejecting ABORTED) —
 * a deterministic stand-in for a real network call that is still in flight when a deadline elapses. */
function makeHangingUntilAbortLlm(): LlmPort {
  return {
    provider: "hanging",
    modelId: "hanging-model",
    async generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
      return new Promise((_resolve, reject) => {
        if (req.abort?.aborted === true) {
          reject(new LlmError("ABORTED", "aborted(test)"));
          return;
        }
        req.abort?.addEventListener("abort", () => reject(new LlmError("ABORTED", "aborted(test)")), {
          once: true,
        });
      });
    },
    async generateText() {
      throw new Error("hanging stub: generateText not supported");
    },
  };
}

describe("compose: deadline guard in-flight abort (the abort-classification subtlety)", () => {
  it("a deadline elapsing mid-call aborts the in-flight LLM call and is classified as a budget fallback, not a client cancellation", async () => {
    const llm = makeHangingUntilAbortLlm();
    const captured: ComposeErrorContext[] = [];
    const ctx: ComposeContext = {
      ...makeCtx(llm, { budget: { deadlineMs: 20 } }),
      observer: {
        onError: (c) => {
          captured.push(c);
        },
      },
    };

    const { spec, trace } = await compose(GUI_INPUT, ctx);

    expect(spec.provenance.fallback?.from).toBe("L1");
    expect(spec.provenance.fallback?.reason).toMatch(/budget exceeded/i);
    expect(spec.provenance.fallback?.reason).toMatch(/deadline/i);
    expect(spec.provenance.fallback?.reason).toMatch(/during generation/i);
    // The subtlety this whole feature hinges on: an in-flight deadline abort must NOT be marked
    // cancelled (that is reserved for a genuine caller AbortSignal / client disconnect) so hosts do not
    // skip lineage recording for it, and it must count toward the fallback-rate analytics.
    expect(trace.cancelled).toBeUndefined();
    expect(trace.fallback?.reason).toMatch(/deadline/i);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.phase).toBe("fallback");
    expect(captured[0]!.budgetExceeded).toBe(true);
  }, 10_000);

  it("a genuine caller AbortSignal firing first is still classified as cancelled, even with a deadline configured (the two sources are not confused)", async () => {
    const llm = makeHangingUntilAbortLlm();
    const controller = new AbortController();
    const captured: ComposeErrorContext[] = [];
    const ctx: ComposeContext = {
      // A deadline generous enough that it would not fire before the caller's own abort below.
      ...makeCtx(llm, { budget: { deadlineMs: 60_000 } }),
      observer: {
        onError: (c) => {
          captured.push(c);
        },
      },
    };

    const composePromise = compose(GUI_INPUT, ctx, { abort: controller.signal });
    controller.abort(); // the caller cancels almost immediately, well before the 60s deadline
    const { spec, trace } = await composePromise;

    expect(spec.provenance.fallback?.from).toBe("L1");
    expect(trace.cancelled).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.phase).toBe("cancelled");
  }, 10_000);
});

describe("composeStream: deadline guard", () => {
  it("a deadlineMs:0 downgrade flows as skeleton → fallback patch (no LLM call), mirroring the token-budget guard", async () => {
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    const events = [];
    for await (const ev of composeStream(GUI_INPUT, makeCtx(llm, { budget: { deadlineMs: 0 } }))) {
      events.push(ev);
    }

    expect(llm.calls).toHaveLength(0);
    expect(events.map((e) => e.kind)).toEqual(["spec", "patch", "done"]);
    const done = events[2]!;
    if (done.kind === "done") {
      expect(done.result.spec.provenance.fallback?.reason).toMatch(/deadline/i);
      expect(done.result.trace.cancelled).toBeUndefined();
    }
  });
});

import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { GuiAction } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type ComposeContext, type ComposeObserver, compose, composeObservers } from "../src/index.js";
import { catalog, goodRawDraft, makeSemantic, makeStorage } from "./helpers.js";

const GUI_INPUT: GuiAction = {
  kind: "gui",
  action: "facet.change",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
};

function baseCtx(observer?: ComposeObserver): ComposeContext {
  return {
    catalog,
    semantic: makeSemantic(),
    storage: makeStorage(),
    llm: new FakeLlm({ objects: [goodRawDraft()] }),
    policy: {},
    ...(observer != null ? { observer } : {}),
  };
}

describe("composeObservers", () => {
  it("with no observers returns an observer with no hooks (indistinguishable from unwired)", () => {
    const merged = composeObservers();
    expect(merged.onComposed).toBeUndefined();
    expect(merged.onError).toBeUndefined();
    expect(merged.onBudgetCheckError).toBeUndefined();
  });

  it("ignores undefined entries (a conditionally-wired observer)", () => {
    let called = 0;
    const merged = composeObservers(undefined, { onComposed: () => void called++ }, undefined);
    expect(merged.onComposed).toBeDefined();
    merged.onComposed?.({} as never, {} as never);
    expect(called).toBe(1);
  });

  it("calls onComposed on every input observer for the same compose", async () => {
    const calledA: unknown[] = [];
    const calledB: unknown[] = [];
    const merged = composeObservers(
      { onComposed: (trace) => void calledA.push(trace) },
      { onComposed: (trace) => void calledB.push(trace) },
    );
    await compose(GUI_INPUT, baseCtx(merged));
    // onComposed is fire-and-forget (async, via fireObserverHook) -- wait a tick for both to land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calledA.length).toBe(1);
    expect(calledB.length).toBe(1);
  });

  it("isolates a throwing observer: the other observer(s) still run and compose still succeeds (fail-open)", async () => {
    const calledB: unknown[] = [];
    const merged = composeObservers(
      {
        onComposed: () => {
          throw new Error("observer A is broken");
        },
      },
      { onComposed: (trace) => void calledB.push(trace) },
    );
    const result = await compose(GUI_INPUT, baseCtx(merged));
    expect(result.spec).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calledB.length).toBe(1);
  });

  it("isolates a rejecting-async observer the same way (fail-open, no unhandledRejection)", async () => {
    const calledB: unknown[] = [];
    const merged = composeObservers(
      {
        onComposed: async () => {
          throw new Error("observer A rejects asynchronously");
        },
      },
      { onComposed: (trace) => void calledB.push(trace) },
    );
    const result = await compose(GUI_INPUT, baseCtx(merged));
    expect(result.spec).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calledB.length).toBe(1);
  });
});

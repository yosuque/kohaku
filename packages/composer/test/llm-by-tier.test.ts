import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { GuiAction } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type ComposeContext, compose, policyFingerprint, tierLlmFingerprintMaterial } from "../src/index.js";
import { catalog, goodRawDraft, makeSemantic, makeStorage } from "./helpers.js";

const GUI_INPUT: GuiAction = {
  kind: "gui",
  action: "facet.change",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
};

/** A minimal correct L2 output (bridge contract: fetchData → render → ready). */
const GOOD_HTML = [
  '<!DOCTYPE html><html><head><title>Sales widget</title></head><body><div id="app"></div><script>',
  "async function main() {",
  '  const data = await window.kohaku.fetchData("query://sales/summary?fy=2026&groupBy=region&q=3");',
  '  document.getElementById("app").textContent = JSON.stringify(data.rows);',
  "  window.kohaku.ready();",
  "}",
  "main();",
  "</script></body></html>",
].join("\n");

function baseCtx(llm: FakeLlm): Omit<ComposeContext, "policy"> {
  return { catalog, semantic: makeSemantic(), storage: makeStorage(), llm };
}

describe("ComposeContext.llmByTier (per-tier LLM routing)", () => {
  it("L1 is routed to llmByTier.L1 when set, and the base llm is never called", async () => {
    const baseLlm = new FakeLlm({ objects: [goodRawDraft()], modelId: "base-model" });
    const l1Llm = new FakeLlm({ objects: [goodRawDraft()], modelId: "l1-model" });
    const ctx: ComposeContext = { ...baseCtx(baseLlm), llmByTier: { L1: l1Llm }, policy: {} };

    const { trace } = await compose(GUI_INPUT, ctx);

    expect(l1Llm.calls).toHaveLength(1);
    expect(baseLlm.calls).toHaveLength(0);
    // TierResult.model / the trace's recorded model reflects the tier's actual port.
    expect(trace.attempts[0]!.ok).toBe(true);
  });

  it("L2 is routed to llmByTier.L2 when set, and the base llm is never called", async () => {
    const baseLlm = new FakeLlm({ objects: [goodRawDraft()], modelId: "base-model" });
    const l2Llm = new FakeLlm({ texts: [GOOD_HTML], modelId: "l2-model" });
    const ctx: ComposeContext = {
      ...baseCtx(baseLlm),
      llmByTier: { L2: l2Llm },
      policy: { allowL2: true, routeTier: () => "L2" },
    };

    await compose(GUI_INPUT, ctx);

    expect(l2Llm.calls).toHaveLength(1);
    expect(baseLlm.calls).toHaveLength(0);
  });

  it("a tier not present in llmByTier still falls back to the base llm", async () => {
    const baseLlm = new FakeLlm({ objects: [goodRawDraft()], modelId: "base-model" });
    const l2Llm = new FakeLlm({ texts: [GOOD_HTML], modelId: "l2-model" });
    // llmByTier only overrides L2; L1 (the route actually taken here) must still use baseLlm.
    const ctx: ComposeContext = { ...baseCtx(baseLlm), llmByTier: { L2: l2Llm }, policy: {} };

    await compose(GUI_INPUT, ctx);

    expect(baseLlm.calls).toHaveLength(1);
    expect(l2Llm.calls).toHaveLength(0);
  });

  it("model recording: L1's trace.model is the L1-tier port's modelId, not the base's", async () => {
    const baseLlm = new FakeLlm({ objects: [goodRawDraft()], modelId: "base-model" });
    const l1Llm = new FakeLlm({ objects: [goodRawDraft()], modelId: "l1-fine-tuned" });
    const ctx: ComposeContext = { ...baseCtx(baseLlm), llmByTier: { L1: l1Llm }, policy: {} };

    const { trace } = await compose(GUI_INPUT, ctx);
    expect(trace.tier).toBe("L1");
    expect(trace.model).toBe("l1-fine-tuned");
  });

  it("model recording: L2's trace.model is the L2-tier port's modelId, not the base's (the bug this WP fixes)", async () => {
    const baseLlm = new FakeLlm({ objects: [goodRawDraft()], modelId: "base-model" });
    const l2Llm = new FakeLlm({ texts: [GOOD_HTML], modelId: "l2-fine-tuned" });
    const ctx: ComposeContext = {
      ...baseCtx(baseLlm),
      llmByTier: { L2: l2Llm },
      policy: { allowL2: true, routeTier: () => "L2" },
    };

    const { trace } = await compose(GUI_INPUT, ctx);
    expect(trace.tier).toBe("L2");
    expect(trace.model).toBe("l2-fine-tuned");
  });

  describe("cacheKey correctness", () => {
    it("llmByTier unset: cacheKey is byte-identical to a plain ComposeContext (no tierLlm fingerprint material)", async () => {
      const llm = new FakeLlm({ objects: [goodRawDraft()], modelId: "base-model" });
      const ctx: ComposeContext = { ...baseCtx(llm), policy: { generatorVersion: "gv1" } };
      expect(tierLlmFingerprintMaterial(ctx)).toBeUndefined();
      const { trace } = await compose(GUI_INPUT, ctx);
      expect(trace.cacheKey.endsWith(":gv1")).toBe(true);
    });

    it("llmByTier set but matching the base model: no fingerprint contribution, cacheKey unchanged", async () => {
      const baseLlm = new FakeLlm({
        objects: [goodRawDraft()],
        modelId: "same-model",
        provider: "same-provider",
      });
      const sameLlm = new FakeLlm({
        objects: [goodRawDraft()],
        modelId: "same-model",
        provider: "same-provider",
      });
      const withoutOverride: ComposeContext = { ...baseCtx(baseLlm), policy: { generatorVersion: "gv1" } };
      const withMatchingOverride: ComposeContext = {
        ...baseCtx(baseLlm),
        llmByTier: { L1: sameLlm },
        policy: { generatorVersion: "gv1" },
      };
      expect(tierLlmFingerprintMaterial(withMatchingOverride)).toBeUndefined();

      const a = await compose(GUI_INPUT, withoutOverride);
      const b = await compose(GUI_INPUT, {
        ...withMatchingOverride,
        llm: new FakeLlm({ objects: [goodRawDraft()], modelId: "same-model", provider: "same-provider" }),
      });
      expect(a.trace.cacheKey).toBe(b.trace.cacheKey);
    });

    it("llmByTier.L1 with a genuinely different model: cacheKey separates from the base-only compose", async () => {
      const baseLlm = new FakeLlm({ objects: [goodRawDraft()], modelId: "base-model" });
      const l1Llm = new FakeLlm({ objects: [goodRawDraft()], modelId: "distilled-l1-model" });

      const baseOnly = await compose(GUI_INPUT, {
        ...baseCtx(baseLlm),
        policy: { generatorVersion: "gv1" },
      });
      const withL1Override = await compose(GUI_INPUT, {
        ...baseCtx(baseLlm),
        llmByTier: { L1: l1Llm },
        policy: { generatorVersion: "gv1" },
      });

      expect(baseOnly.trace.cacheKey).not.toBe(withL1Override.trace.cacheKey);
    });

    it("policyFingerprint(policy, tierLlm) is empty only when tierLlm is undefined too", async () => {
      const material = { l1: { provider: "p", modelId: "distilled" } };
      const withMaterial = await policyFingerprint({}, material);
      const withoutMaterial = await policyFingerprint({});
      expect(withoutMaterial).toBe("");
      expect(withMaterial).not.toBe("");
      expect(withMaterial).toMatch(/^[0-9a-f]{16}$/);
    });
  });
});

import type { GenerateObjectRequest, GenerateObjectResult, LlmPort } from "@kohaku-ui/llm";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import {
  type CanonicalIntent,
  type ComponentNode,
  canonicalStringify,
  type EventBinding,
} from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type ComposeContext, compose, type FewShotExample } from "../src/index.js";
import { buildL1Prompt } from "../src/prompt.js";
import { catalog, goodRawDraft, makeSemantic, makeStorage, REF } from "./helpers.js";

const INTENT: CanonicalIntent = {
  canonical: "sales.quarterly_summary",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
  hash: `sha256:${"a".repeat(64)}`,
};

const INTENT_INPUT = {
  kind: "intent" as const,
  intent: { canonical: "sales.quarterly_summary", params: INTENT.params },
};

function baseArgs() {
  return {
    intent: INTENT,
    catalog,
    refs: [REF],
    shapesByRef: new Map<string, never>(),
  };
}

/** A minimal few-shot example with canonical embedded in the title too (so the token reliably appears in canonicalStringify). */
function example(canonical: string): FewShotExample {
  const components: ComponentNode[] = [
    { id: "root", type: "layout.stack", props: {}, children: ["h"] },
    { id: "h", type: "text.heading", props: { level: 2, text: canonical } },
  ];
  const events: EventBinding[] = [];
  return { intent: { canonical, params: {} }, spec: { components, events } };
}

/** An LlmPort stub that captures generateObject's prompt (fixed response). */
function capturingLlm(response: unknown): { llm: LlmPort; captured: { prompt: string }[] } {
  const captured: { prompt: string }[] = [];
  const llm: LlmPort = {
    provider: "fake",
    modelId: "fake-model",
    async generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
      captured.push({ prompt: req.prompt });
      return { object: response as T, usage: { inputTokens: 0, outputTokens: 0 }, model: "fake-model" };
    },
    async generateText() {
      throw new Error("unused");
    },
  };
  return { llm, captured };
}

function makeCtx(llm: LlmPort, policy: ComposeContext["policy"]): ComposeContext {
  return { catalog, semantic: makeSemantic(), storage: makeStorage(), llm, policy };
}

describe("buildL1Prompt: few-shot(3-9)", () => {
  it("fewShot unspecified and an empty array yield the same string as current (no section added)", () => {
    const without = buildL1Prompt(baseArgs());
    const withEmpty = buildL1Prompt({ ...baseArgs(), fewShot: [] });
    expect(withEmpty).toBe(without);
    expect(without).not.toContain("## Examples of good composition");
  });

  it("with fewShot specified, the 'Examples of good composition' section goes after the catalog and before the instructions", () => {
    const prompt = buildL1Prompt({ ...baseArgs(), fewShot: [example("exalpha"), example("exbeta")] });
    expect(prompt).toContain(
      "## Examples of good composition (follow this form; data must be $ref references)",
    );
    const catalogIdx = prompt.indexOf("## Component catalog");
    const fewShotIdx = prompt.indexOf("## Examples of good composition");
    const instrIdx = prompt.indexOf("## Instructions");
    expect(catalogIdx).toBeGreaterThanOrEqual(0);
    expect(catalogIdx).toBeLessThan(fewShotIdx);
    expect(fewShotIdx).toBeLessThan(instrIdx);
    // Injected in the form of intent and {components,events} passed through canonicalStringify
    expect(prompt).toContain(canonicalStringify({ canonical: "exalpha", params: {} }));
    expect(prompt).toContain('"components"');
    expect(prompt).toContain("exbeta");
  });
});

describe("l1-generate: few-shot(3-9)", () => {
  it("even if examples returns 3, injects only maxExamples default 2 (truncated)", async () => {
    const { llm, captured } = capturingLlm(goodRawDraft(REF));
    let callCount = 0;
    await compose(
      INTENT_INPUT,
      makeCtx(llm, {
        fewShot: {
          examples: async () => {
            callCount += 1;
            return [example("exalpha"), example("exbeta"), example("exgamma")];
          },
        },
      }),
    );
    const prompt = captured.at(-1)!.prompt;
    expect(callCount).toBe(1);
    expect(prompt).toContain("exalpha");
    expect(prompt).toContain("exbeta");
    // The 3rd one is cut off by maxExamples=2 and does not appear in the prompt
    expect(prompt).not.toContain("exgamma");
  });

  it("specifying maxExamples changes the count", async () => {
    const { llm, captured } = capturingLlm(goodRawDraft(REF));
    await compose(
      INTENT_INPUT,
      makeCtx(llm, {
        fewShot: {
          maxExamples: 1,
          examples: async () => [example("exalpha"), example("exbeta")],
        },
      }),
    );
    const prompt = captured.at(-1)!.prompt;
    expect(prompt).toContain("exalpha");
    expect(prompt).not.toContain("exbeta");
  });

  it("the same examples are included in every attempt including repair retries, and examples is called only once", async () => {
    // Return an invalid type on the first call to induce the repair loop once
    const bad = {
      components: [
        { id: "root", type: "layout.stack", props: { direction: "vertical", gap: null }, children: ["x"] },
        { id: "x", type: "no.such_type", props: {} },
      ],
      events: [],
    };
    const llm = new FakeLlm({ objects: [bad, goodRawDraft()] });
    let callCount = 0;
    await compose(
      INTENT_INPUT,
      makeCtx(llm, {
        fewShot: {
          examples: async () => {
            callCount += 1;
            return [example("exalpha")];
          },
        },
      }),
    );
    expect(callCount).toBe(1); // fetched just once before the loop
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0]!.prompt).toContain("exalpha");
    expect(llm.calls[1]!.prompt).toContain("exalpha"); // the same example in the repair attempt too
    expect(llm.calls[1]!.prompt).toContain("Problems in the previous generation");
  });

  it("a throw in examples is swallowed and generation continues", async () => {
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    const { spec, trace } = await compose(
      INTENT_INPUT,
      makeCtx(llm, {
        fewShot: {
          examples: async () => {
            throw new Error("few-shot supply-side failure");
          },
        },
      }),
    );
    expect(spec.provenance.tier).toBe("L1");
    expect(trace.attempts[0]!.ok).toBe(true);
    // Because few-shot is treated as empty, the section is not included
    expect(llm.calls[0]!.prompt).not.toContain("## Examples of good composition");
  });
});

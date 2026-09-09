import type { GenerateObjectRequest, GenerateObjectResult, LlmPort } from "@kohaku-ui/llm";
import type { GuiAction } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import {
  appendL1RepairFeedback,
  buildL1Prompt,
  buildL1PromptParts,
  buildL1PromptStatic,
  type ComposeContext,
  compose,
} from "../src/index.js";
import { catalog, goodRawDraft, makeSemantic, makeStorage } from "./helpers.js";

const GUI_INPUT: GuiAction = {
  kind: "gui",
  action: "facet.change",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
};

/** empty components = catalog/structural-validation failure (repair-target "invalid"; forces a 2nd attempt). */
const BAD = { components: [], events: [] };

function makeCtx(llm: LlmPort): ComposeContext {
  return { catalog, semantic: makeSemantic(), storage: makeStorage(), llm, policy: {} };
}

describe("buildL1PromptStatic / appendL1RepairFeedback: equivalence with buildL1Prompt", () => {
  const baseArgs = {
    intent: { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) },
    catalog,
    refs: ["query://sales/summary?fy=2026&groupBy=region&q=3"],
    shapesByRef: new Map(),
  };

  it("static + append (no feedback) is byte-identical to buildL1Prompt with no repairFeedback", () => {
    expect(appendL1RepairFeedback(buildL1PromptStatic(baseArgs))).toBe(buildL1Prompt(baseArgs));
  });

  it("static + append (with feedback) is byte-identical to buildL1Prompt with repairFeedback", () => {
    const feedback = ["components is empty"];
    expect(appendL1RepairFeedback(buildL1PromptStatic(baseArgs), feedback)).toBe(
      buildL1Prompt({ ...baseArgs, repairFeedback: feedback }),
    );
  });
});

describe("buildL1PromptParts: promptParts invariant (cacheable + rest === buildL1Prompt)", () => {
  const baseArgs = {
    intent: { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) },
    catalog,
    refs: ["query://sales/summary?fy=2026&groupBy=region&q=3"],
    shapesByRef: new Map(),
  };

  it("with no repairFeedback: cacheable is the whole prompt and rest is empty", () => {
    const parts = buildL1PromptParts(baseArgs);
    expect(parts.cacheable + parts.rest).toBe(buildL1Prompt(baseArgs));
    expect(parts.cacheable).toBe(buildL1PromptStatic(baseArgs));
    expect(parts.rest).toBe("");
  });

  it("with repairFeedback: cacheable stays the static prompt and rest carries only the feedback section", () => {
    const feedback = ["components is empty"];
    const parts = buildL1PromptParts({ ...baseArgs, repairFeedback: feedback });
    expect(parts.cacheable + parts.rest).toBe(buildL1Prompt({ ...baseArgs, repairFeedback: feedback }));
    expect(parts.cacheable).toBe(buildL1PromptStatic(baseArgs));
    expect(parts.rest).toContain("## Problems in the previous generation");
  });
});

describe("generateL1: the static prompt prefix is reused across repair attempts", () => {
  it("attempt 1 and attempt 2 (repair) share the identical static prefix; only the trailing feedback section differs", async () => {
    const prompts: string[] = [];
    const promptPartsSeen: ({ cacheable: string; rest: string } | undefined)[] = [];
    const llm: LlmPort = {
      provider: "capture",
      modelId: "capture-model",
      async generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
        prompts.push(req.prompt);
        promptPartsSeen.push(req.promptParts);
        const object = (prompts.length === 1 ? BAD : goodRawDraft()) as T;
        return { object, model: "capture-model", usage: { inputTokens: 0, outputTokens: 0 } };
      },
      async generateText() {
        throw new Error("capture stub: generateText not supported");
      },
    };
    const result = await compose(GUI_INPUT, makeCtx(llm));
    expect(result.trace.tier).toBe("L1");
    expect(prompts).toHaveLength(2);

    // Attempt 1 has no feedback section; attempt 2 (repair) does.
    expect(prompts[0]).not.toContain("## Problems in the previous generation");
    expect(prompts[1]).toContain("## Problems in the previous generation");
    // The static prefix (everything before the feedback section) must be identical between the two —
    // the whole point of building it once and only appending feedback per attempt.
    const feedbackHeading = "\n\n## Problems in the previous generation";
    const staticPrefixOfAttempt2 = prompts[1]!.slice(0, prompts[1]!.indexOf(feedbackHeading));
    expect(staticPrefixOfAttempt2).toBe(prompts[0]);

    // promptParts (opt-in prompt-caching boundary): cacheable is the same static prefix on both
    // attempts (the whole point — a caching-capable adapter can reuse it across the repair retry),
    // rest differs, and cacheable+rest always reconstructs the exact prompt sent (the port invariant).
    expect(promptPartsSeen[0]!.cacheable).toBe(staticPrefixOfAttempt2);
    expect(promptPartsSeen[1]!.cacheable).toBe(staticPrefixOfAttempt2);
    expect(promptPartsSeen[0]!.rest).toBe("");
    expect(promptPartsSeen[1]!.rest).toContain("## Problems in the previous generation");
    expect(promptPartsSeen[0]!.cacheable + promptPartsSeen[0]!.rest).toBe(prompts[0]);
    expect(promptPartsSeen[1]!.cacheable + promptPartsSeen[1]!.rest).toBe(prompts[1]);
  });
});

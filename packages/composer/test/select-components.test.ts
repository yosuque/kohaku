import type { GenerateObjectRequest, GenerateObjectResult, LlmPort } from "@kohaku-ui/llm";
import { describe, expect, it } from "vitest";
import { type ComposeContext, compose } from "../src/index.js";
import { catalog, goodRawDraft, makeSemantic, makeStorage, REF } from "./helpers.js";

const INTENT_INPUT = {
  kind: "intent" as const,
  intent: {
    canonical: "sales.quarterly_summary",
    params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
  },
};

/** An LlmPort stub that captures generateObject's prompt and generation schema (jsonSchema). */
function capturingLlm(response: unknown): {
  llm: LlmPort;
  captured: { prompt: string; jsonSchema: any }[];
} {
  const captured: { prompt: string; jsonSchema: any }[] = [];
  const llm: LlmPort = {
    provider: "fake",
    modelId: "fake-model",
    async generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
      captured.push({ prompt: req.prompt, jsonSchema: (req.schema as { jsonSchema: any }).jsonSchema });
      return { object: response as T, usage: { inputTokens: 0, outputTokens: 0 }, model: "fake-model" };
    },
    async generateText() {
      throw new Error("unused");
    },
  };
  return { llm, captured };
}

function variantTypes(jsonSchema: any): string[] {
  return (jsonSchema.properties.components.items.anyOf as any[])
    .map((v) => v.properties.type.const as string)
    .sort();
}

function makeCtx(llm: LlmPort, policy: ComposeContext["policy"]): ComposeContext {
  return { catalog, semantic: makeSemantic(), storage: makeStorage(), llm, policy };
}

describe("selectComponents affects both the generation schema and the prompt", () => {
  it("the schema's variants are narrowed to the selected types + guardrails", async () => {
    const { llm, captured } = capturingLlm(goodRawDraft(REF));
    await compose(
      INTENT_INPUT,
      makeCtx(llm, {
        selectComponents: () => ["presentChart", "presentSpreadsheet", "text.heading"],
      }),
    );
    const last = captured.at(-1)!;
    expect(variantTypes(last.jsonSchema)).toEqual(
      ["layout.stack", "presentChart", "presentMarkdown", "presentSpreadsheet", "text.heading"].sort(),
    );
  });

  it("the prompt's catalog enumeration is narrowed to the same vocabulary (matches the schema)", async () => {
    const { llm, captured } = capturingLlm(goodRawDraft(REF));
    await compose(
      INTENT_INPUT,
      makeCtx(llm, {
        selectComponents: () => ["presentChart", "presentSpreadsheet", "text.heading"],
      }),
    );
    const prompt = captured.at(-1)!.prompt;
    expect(prompt).toContain("presentChart@");
    expect(prompt).toContain("presentSpreadsheet@");
    // Components dropped by the narrowing do not appear in the prompt either
    expect(prompt).not.toContain("presentForm@");
    expect(prompt).not.toContain("presentMetric@");
  });

  it("returning undefined yields all (no narrowing)", async () => {
    const { llm, captured } = capturingLlm(goodRawDraft(REF));
    await compose(INTENT_INPUT, makeCtx(llm, { selectComponents: () => undefined }));
    const types = variantTypes(captured.at(-1)!.jsonSchema);
    expect(types).toContain("presentForm");
    expect(types).toContain("presentMetric");
    expect(types).not.toContain("ui.loading"); // excluded is always excluded
  });
});

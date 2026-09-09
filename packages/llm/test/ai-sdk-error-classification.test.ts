import { beforeEach, describe, expect, it, vi } from "vitest";

// Pins the AI SDK 7 error-name → LlmError-code mapping in ai-sdk.ts's wrapError, and the AI SDK 7 call
// shape (generateText's `instructions` field / Output.object's `name` field) the migration to the Output
// API introduced. Nothing else in the repo references AI_NoObjectGeneratedError / AI_NoOutputGeneratedError,
// so without this file a wrong or stale error-name string (or a future SDK rename of `instructions`/`name`)
// would silently change INVALID_OUTPUT-vs-PROVIDER classification (which decides "feed validation errors
// back through the repair loop" vs "retry / fall back") with every other test still green.
// Same mocking approach as ai-sdk-retry.test.ts: replace "ai"'s generateText, which is the single funnel for
// both the native structured attempt and the prompt-JSON fallback since AI SDK 7 removed generateObject.
const { generateTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
}));

vi.mock("ai", () => ({
  generateText: (opts: unknown) => generateTextMock(opts),
  jsonSchema: (s: unknown) => s,
  Output: { object: (opts: unknown) => opts },
}));

import { createAiSdkLlm } from "../src/adapters/ai-sdk.js";
import { resolveLlmEnv } from "../src/env.js";

// structuredMode "strict" is used for the classification tests so a rejection propagates immediately as a
// single wrapError() result with no prompt-JSON fallback retry muddying which call produced the code.
const strictConfig = resolveLlmEnv({ KOHAKU_LLM_STRUCTURED_MODE: "strict" });
const deps = { sleep: async (): Promise<void> => {}, now: () => 0, random: () => 0.5 };
const jsonSchemaReq = {
  schema: { jsonSchema: { type: "object" } },
  prompt: "p",
  schemaName: "ui_spec_draft",
} as const;

function namedError(name: string): Error {
  return Object.assign(new Error(`simulated ${name}`), { name });
}

beforeEach(() => {
  generateTextMock.mockReset();
});

describe("wrapError: AI SDK 7 error-name classification", () => {
  it.each(["AI_NoObjectGeneratedError", "AI_NoOutputGeneratedError"] as const)(
    "%s (Output.object's parse/validate failure) classifies as INVALID_OUTPUT",
    async (name) => {
      generateTextMock.mockRejectedValue(namedError(name));
      const llm = createAiSdkLlm(strictConfig, deps);

      await expect(llm.generateObject(jsonSchemaReq)).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
      expect(generateTextMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["AbortError", "TimeoutError"] as const)("%s classifies as ABORTED", async (name) => {
    generateTextMock.mockRejectedValue(namedError(name));
    const llm = createAiSdkLlm(strictConfig, deps);

    await expect(llm.generateObject(jsonSchemaReq)).rejects.toMatchObject({ code: "ABORTED" });
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it("an unrelated error name classifies as PROVIDER", async () => {
    generateTextMock.mockRejectedValue(namedError("SomeUnrelatedSdkError"));
    const llm = createAiSdkLlm(strictConfig, deps);

    await expect(llm.generateObject(jsonSchemaReq)).rejects.toMatchObject({ code: "PROVIDER" });
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it("a plain Error with no name at all also classifies as PROVIDER (the default branch)", async () => {
    generateTextMock.mockRejectedValue(new Error("no name here"));
    const llm = createAiSdkLlm(strictConfig, deps);

    await expect(llm.generateObject(jsonSchemaReq)).rejects.toMatchObject({ code: "PROVIDER" });
  });
});

describe("AI SDK 7 call shape (Output API migration)", () => {
  it("generateObject passes `instructions` (not `system`) for the system prompt", async () => {
    generateTextMock.mockResolvedValueOnce({ output: { ok: true }, usage: {} });
    const llm = createAiSdkLlm(strictConfig, deps);

    await llm.generateObject({ ...jsonSchemaReq, system: "be a helpful UI composer" });

    const call = generateTextMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.instructions).toBe("be a helpful UI composer");
    expect(call).not.toHaveProperty("system");
  });

  it("generateObject builds output via Output.object with `name` (not `schemaName`)", async () => {
    generateTextMock.mockResolvedValueOnce({ output: { ok: true }, usage: {} });
    const llm = createAiSdkLlm(strictConfig, deps);

    await llm.generateObject(jsonSchemaReq);

    const call = generateTextMock.mock.calls[0]![0] as { output: Record<string, unknown> };
    expect(call.output.name).toBe(jsonSchemaReq.schemaName);
    expect(call.output).not.toHaveProperty("schemaName");
    expect(call.output.schema).toBe(jsonSchemaReq.schema.jsonSchema);
  });

  it("generateText also passes `instructions` (not `system`)", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "hi", usage: {} });
    const llm = createAiSdkLlm(strictConfig, deps);

    await llm.generateText({ prompt: "p", system: "be terse" });

    const call = generateTextMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.instructions).toBe("be terse");
    expect(call).not.toHaveProperty("system");
  });
});

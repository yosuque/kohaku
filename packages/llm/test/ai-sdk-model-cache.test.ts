import { beforeEach, describe, expect, it, vi } from "vitest";

// Replace "ai"'s generateText so a successful call after model resolution succeeds does not hit a
// real provider (the adapter's generateObject port method now calls generateText + Output.object()).
const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }));
vi.mock("ai", () => ({
  generateText: (opts: unknown) => generateTextMock(opts),
  jsonSchema: (s: unknown) => s,
  Output: { object: (opts: unknown) => opts },
}));

// Control model resolution directly: reject on the first call, resolve on the second, so the test can
// pin createAiSdkLlm's own caching behavior around a failed resolveModel() attempt.
const { chatModelMock } = vi.hoisted(() => ({ chatModelMock: vi.fn() }));
const { createOpenAICompatibleMock } = vi.hoisted(() => ({
  createOpenAICompatibleMock: vi.fn((_opts: unknown) => ({ chatModel: chatModelMock })),
}));
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: (opts: unknown) => createOpenAICompatibleMock(opts),
}));

import { createAiSdkLlm } from "../src/adapters/ai-sdk.js";
import { resolveLlmEnv } from "../src/env.js";

const config = resolveLlmEnv({
  KOHAKU_LLM_PROVIDER: "ollama",
  KOHAKU_LLM_MODEL: "gemma4:e4b",
  KOHAKU_LLM_BASE_URL: "http://localhost:11434/v1",
});
const deps = { sleep: async (): Promise<void> => {}, now: () => 0, random: () => 0.5 };
const jsonSchemaReq = { schema: { jsonSchema: { type: "object" } }, prompt: "p" } as const;

beforeEach(() => {
  generateTextMock.mockReset();
  createOpenAICompatibleMock.mockClear();
  chatModelMock.mockReset();
});

describe("createAiSdkLlm: model-resolution cache discards a rejected attempt", () => {
  it("a transient model-resolution failure does not permanently wedge the port; the next call retries resolveModel()", async () => {
    chatModelMock
      .mockImplementationOnce(() => {
        throw new Error("transient resolution failure");
      })
      .mockImplementationOnce(() => "resolved-model");
    generateTextMock.mockResolvedValue({ output: { ok: true }, usage: { inputTokens: 1, outputTokens: 2 } });

    const llm = createAiSdkLlm(config, deps);

    await expect(llm.generateObject(jsonSchemaReq)).rejects.toThrow();
    // The second call must attempt resolveModel() again (not re-throw a cached rejection) and succeed.
    const r = await llm.generateObject(jsonSchemaReq);
    expect(r).toMatchObject({ object: { ok: true } });
    expect(chatModelMock).toHaveBeenCalledTimes(2);
  });

  it("a successful resolution is still cached (resolveModel runs at most once across many calls)", async () => {
    chatModelMock.mockReturnValue("resolved-model");
    generateTextMock.mockResolvedValue({ output: { ok: true }, usage: { inputTokens: 1, outputTokens: 2 } });

    const llm = createAiSdkLlm(config, deps);
    await llm.generateObject(jsonSchemaReq);
    await llm.generateObject(jsonSchemaReq);
    await llm.generateObject(jsonSchemaReq);
    expect(chatModelMock).toHaveBeenCalledTimes(1);
  });
});

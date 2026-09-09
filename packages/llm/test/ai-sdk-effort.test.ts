import { beforeEach, describe, expect, it, vi } from "vitest";

// Same "ai" mock convention as ai-sdk-retry.test.ts / ai-sdk-prompt-cache.test.ts: generateText is the
// single funnel for both the native structured attempt and the plain generateText port method under AI SDK 7.
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

const deps = { sleep: async (): Promise<void> => {}, now: () => 0, random: () => 0.5 };

beforeEach(() => {
  generateTextMock.mockReset();
  generateTextMock.mockResolvedValue({
    output: { ok: true },
    text: "ok",
    usage: { inputTokens: 1, outputTokens: 1 },
  });
});

describe("createAiSdkLlm reasoning effort (GenerateObjectRequest/GenerateTextRequest.effort)", () => {
  it("effort unset: no providerOptions key is added at all", async () => {
    const config = resolveLlmEnv({});
    const llm = createAiSdkLlm(config, deps);
    await llm.generateText({ prompt: "hi" });
    const call = generateTextMock.mock.calls[0]![0] as { providerOptions?: unknown };
    expect(call.providerOptions).toBeUndefined();
  });

  it("claude: effort is sent as providerOptions.anthropic.effort", async () => {
    const config = resolveLlmEnv({});
    expect(config.provider).toBe("claude");
    const llm = createAiSdkLlm(config, deps);
    await llm.generateText({ prompt: "hi", effort: "high" });
    const call = generateTextMock.mock.calls[0]![0] as { providerOptions?: unknown };
    expect(call.providerOptions).toEqual({ anthropic: { effort: "high" } });
  });

  it("openai: effort is sent as providerOptions.openai.reasoningEffort", async () => {
    const config = resolveLlmEnv({ KOHAKU_LLM_PROVIDER: "openai" });
    const llm = createAiSdkLlm(config, deps);
    await llm.generateText({ prompt: "hi", effort: "low" });
    const call = generateTextMock.mock.calls[0]![0] as { providerOptions?: unknown };
    expect(call.providerOptions).toEqual({ openai: { reasoningEffort: "low" } });
  });

  it("ollama: effort is sent as providerOptions.openaiCompatible.reasoningEffort", async () => {
    const config = resolveLlmEnv({ KOHAKU_LLM_PROVIDER: "ollama" });
    const llm = createAiSdkLlm(config, deps);
    await llm.generateText({ prompt: "hi", effort: "medium" });
    const call = generateTextMock.mock.calls[0]![0] as { providerOptions?: unknown };
    expect(call.providerOptions).toEqual({ openaiCompatible: { reasoningEffort: "medium" } });
  });

  it("llama: effort is sent as providerOptions.openaiCompatible.reasoningEffort", async () => {
    const config = resolveLlmEnv({
      KOHAKU_LLM_PROVIDER: "llama",
      KOHAKU_LLM_BASE_URL: "http://localhost:9999/v1",
      KOHAKU_LLM_MODEL: "my-local-model",
    });
    const llm = createAiSdkLlm(config, deps);
    await llm.generateText({ prompt: "hi", effort: "xhigh" });
    const call = generateTextMock.mock.calls[0]![0] as { providerOptions?: unknown };
    expect(call.providerOptions).toEqual({ openaiCompatible: { reasoningEffort: "xhigh" } });
  });

  it("gemini: effort is silently ignored (no matching provider option)", async () => {
    const config = resolveLlmEnv({ KOHAKU_LLM_PROVIDER: "gemini" });
    const llm = createAiSdkLlm(config, deps);
    await llm.generateText({ prompt: "hi", effort: "max" });
    const call = generateTextMock.mock.calls[0]![0] as { providerOptions?: unknown };
    expect(call.providerOptions).toBeUndefined();
  });

  it("generateObject also carries effort through to providerOptions (claude)", async () => {
    const config = resolveLlmEnv({});
    const llm = createAiSdkLlm(config, deps);
    await llm.generateObject({
      schema: { jsonSchema: { type: "object" } },
      prompt: "hi",
      effort: "low",
    });
    const call = generateTextMock.mock.calls[0]![0] as { providerOptions?: unknown };
    expect(call.providerOptions).toEqual({ anthropic: { effort: "low" } });
  });
});

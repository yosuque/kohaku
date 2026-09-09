import { beforeEach, describe, expect, it, vi } from "vitest";

// Same "ai" mock convention as ai-sdk-retry.test.ts: generateText is the single funnel for both the
// native structured attempt and the plain generateText port method under AI SDK 7.
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

describe("createAiSdkLlm prompt caching (opt-in, KOHAKU_LLM_PROMPT_CACHE)", () => {
  it("default (promptCache off): the plain prompt string is sent unchanged even when promptParts is given", async () => {
    const config = resolveLlmEnv({});
    expect(config.promptCache).toBe(false);
    const llm = createAiSdkLlm(config, deps);
    await llm.generateObject({
      schema: { jsonSchema: { type: "object" } },
      prompt: "STATICREST",
      promptParts: { cacheable: "STATIC", rest: "REST" },
    });
    const call = generateTextMock.mock.calls[0]![0] as { prompt: unknown };
    expect(call.prompt).toBe("STATICREST");
  });

  it("promptCache on but no promptParts: the plain prompt string is sent unchanged", async () => {
    const config = resolveLlmEnv({ KOHAKU_LLM_PROMPT_CACHE: "1" });
    const llm = createAiSdkLlm(config, deps);
    await llm.generateText({ prompt: "just a string" });
    const call = generateTextMock.mock.calls[0]![0] as { prompt: unknown };
    expect(call.prompt).toBe("just a string");
  });

  it("promptCache on + claude + promptParts: splits into a 2-part user message with cacheControl on the leading part", async () => {
    const config = resolveLlmEnv({ KOHAKU_LLM_PROMPT_CACHE: "1" });
    expect(config.provider).toBe("claude");
    const llm = createAiSdkLlm(config, deps);
    await llm.generateText({
      prompt: "STATICREST",
      promptParts: { cacheable: "STATIC", rest: "REST" },
    });
    const call = generateTextMock.mock.calls[0]![0] as {
      prompt: Array<{
        role: string;
        content: Array<{ type: string; text: string; providerOptions?: unknown }>;
      }>;
    };
    expect(call.prompt).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "STATIC",
            providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
          },
          { type: "text", text: "REST" },
        ],
      },
    ]);
  });

  it("promptCache on + claude + promptParts with an empty rest: only one cached text part is sent (no empty trailing part)", async () => {
    const config = resolveLlmEnv({ KOHAKU_LLM_PROMPT_CACHE: "1" });
    const llm = createAiSdkLlm(config, deps);
    await llm.generateText({
      prompt: "STATIC",
      promptParts: { cacheable: "STATIC", rest: "" },
    });
    const call = generateTextMock.mock.calls[0]![0] as {
      prompt: Array<{ content: unknown[] }>;
    };
    expect(call.prompt[0]!.content).toHaveLength(1);
  });

  it("promptCache on + a non-claude provider: no-op, the plain prompt string is sent (automatic provider-side prefix caching instead)", async () => {
    const config = resolveLlmEnv({ KOHAKU_LLM_PROMPT_CACHE: "1", KOHAKU_LLM_PROVIDER: "openai" });
    const llm = createAiSdkLlm(config, deps);
    await llm.generateText({
      prompt: "STATICREST",
      promptParts: { cacheable: "STATIC", rest: "REST" },
    });
    const call = generateTextMock.mock.calls[0]![0] as { prompt: unknown };
    expect(call.prompt).toBe("STATICREST");
  });

  it("promptCache on + claude but an inconsistent promptParts (cacheable+rest !== prompt): falls back to the plain prompt string rather than sending mismatched content", async () => {
    const config = resolveLlmEnv({ KOHAKU_LLM_PROMPT_CACHE: "1" });
    const llm = createAiSdkLlm(config, deps);
    await llm.generateText({
      prompt: "ACTUAL",
      promptParts: { cacheable: "NOT", rest: "MATCHING" },
    });
    const call = generateTextMock.mock.calls[0]![0] as { prompt: unknown };
    expect(call.prompt).toBe("ACTUAL");
  });
});

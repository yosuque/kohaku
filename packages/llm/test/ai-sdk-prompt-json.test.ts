import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Replace "ai"'s generateObject / generateText to deterministically control provider calls
// (duplicated from ai-sdk-retry.test.ts's harness so this file can force the native structured call to fail
// non-retryably and drive the prompt-JSON fallback path in isolation).
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
import type { LlmError } from "../src/port.js";

function apiError(opts: { isRetryable: boolean; statusCode: number }): Error {
  return Object.assign(new Error(`api ${opts.statusCode}`), {
    name: "AI_APICallError",
    url: "https://example/api",
    responseHeaders: {},
    statusCode: opts.statusCode,
    isRetryable: opts.isRetryable,
  });
}

// Default: claude + retry (max2 / initial250). sleep is immediate, now is fixed (ample deadline), randomness centered.
const config = resolveLlmEnv({});
const deps = { sleep: async (): Promise<void> => {}, now: () => 0, random: () => 0.5 };

// A structured 400 (non-retryable) always forces the native attempt to give up immediately and fall through
// to prompt-JSON mode (see rethrowUnlessPromptFallback: mode "auto" + PROVIDER + non-retryable falls through).
const NON_RETRYABLE_400 = apiError({ isRetryable: false, statusCode: 400 });

beforeEach(() => {
  generateTextMock.mockReset();
  // The first call (the native structured generateText+Output.object attempt) always rejects with a
  // non-retryable 400, forcing the fallthrough to prompt-JSON mode; the prompt-JSON attempt's generateText
  // call is queued per-test via mockResolvedValueOnce (see the comment on NON_RETRYABLE_400 below).
  generateTextMock.mockRejectedValueOnce(NON_RETRYABLE_400);
});

describe("prompt-JSON fallback: extractJson salvage + JSON.parse / zod validation", () => {
  const schema = z.object({ ok: z.number() });

  it.each([
    ["fenced code block", '```json\n{"ok":1}\n```', { object: { ok: 1 } }],
    ["preamble text before the JSON object", 'Sure! Here it is: {"ok":1}', { object: { ok: 1 } }],
  ])("%s is salvaged into a valid object", async (_label, text, expected) => {
    generateTextMock.mockResolvedValueOnce({ text, usage: {} });
    const llm = createAiSdkLlm(config, deps);
    const r = await llm.generateObject({ schema, prompt: "p" });
    expect(r.object).toEqual(expected.object);
    // 1 native structured attempt (rejects with the queued 400) + 1 prompt-JSON fallback attempt.
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it("a top-level JSON array is preserved (not truncated by the object-bracket slicing path)", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "[1,2]", usage: {} });
    const llm = createAiSdkLlm(config, deps);
    // A raw JSON Schema request (not zod) so no schema validation narrows the array away.
    const r = await llm.generateObject<unknown>({ schema: { jsonSchema: { type: "array" } }, prompt: "p" });
    expect(r.object).toEqual([1, 2]);
  });

  it("broken JSON (unparseable even after extraction) → INVALID_OUTPUT", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "{ broken", usage: {} });
    const llm = createAiSdkLlm(config, deps);
    await expect(llm.generateObject({ schema, prompt: "p" })).rejects.toMatchObject({
      code: "INVALID_OUTPUT",
    } satisfies Partial<LlmError>);
  });

  it("valid JSON that does not match the zod schema → INVALID_OUTPUT", async () => {
    generateTextMock.mockResolvedValueOnce({ text: '{"wrong":1}', usage: {} });
    const llm = createAiSdkLlm(config, deps);
    await expect(llm.generateObject({ schema, prompt: "p" })).rejects.toMatchObject({
      code: "INVALID_OUTPUT",
    } satisfies Partial<LlmError>);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// Replace "ai"'s generateText to deterministically control provider calls. Since AI SDK 7, both the native
// structured attempt (generateObject port method → generateText + Output.object()) and the prompt-JSON
// fallback / plain generateText port method all funnel through this single generateText mock (there is no
// more separate generateObject entry point) — tests that exercise the native→fallback sequence queue both
// outcomes on the same mock via mockRejectedValueOnce / mockResolvedValueOnce, in call order.
// jsonSchema is passed through, Output.object is the identity (its arguments are asserted where relevant).
// The type-only LanguageModel is not needed at runtime, so it is not provided.
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
const jsonSchemaReq = { schema: { jsonSchema: { type: "object" } }, prompt: "p" } as const;

beforeEach(() => {
  generateTextMock.mockReset();
});

describe("createAiSdkLlm retry wiring", () => {
  it("a retryable PROVIDER retries on the native path and does not fall back to the prompt", async () => {
    generateTextMock
      .mockRejectedValueOnce(apiError({ isRetryable: true, statusCode: 503 }))
      .mockRejectedValueOnce(apiError({ isRetryable: true, statusCode: 503 }))
      .mockResolvedValueOnce({ output: { ok: true }, usage: { inputTokens: 1, outputTokens: 2 } });

    const llm = createAiSdkLlm(config, deps);
    const r = await llm.generateObject(jsonSchemaReq);

    expect(r).toMatchObject({ object: { ok: true }, model: config.model });
    // All 3 attempts (2 retries + the succeeding one) are native structured attempts; no fallback call needed.
    expect(generateTextMock).toHaveBeenCalledTimes(3);
    // The SDK's built-in retries are disabled (centralized in the llm layer).
    expect(generateTextMock.mock.calls[0]![0]).toMatchObject({ maxRetries: 0 });
  });

  it("a non-retryable PROVIDER (structured 400) does not retry and falls back to prompt JSON immediately", async () => {
    generateTextMock
      .mockRejectedValueOnce(apiError({ isRetryable: false, statusCode: 400 }))
      .mockResolvedValueOnce({ text: JSON.stringify({ ok: 1 }), usage: {} });

    const llm = createAiSdkLlm(config, deps);
    const r = await llm.generateObject(jsonSchemaReq);

    expect(r.object).toEqual({ ok: 1 });
    // 1 native attempt (no retry, non-retryable) + 1 prompt-JSON fallback attempt.
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(generateTextMock.mock.calls[1]![0]).toMatchObject({ maxRetries: 0 });
  });

  it("once retryable PROVIDER attempts are exhausted, it fails with PROVIDER instead of falling back", async () => {
    generateTextMock.mockRejectedValue(apiError({ isRetryable: true, statusCode: 503 }));

    const llm = createAiSdkLlm(config, deps);
    await expect(llm.generateObject(jsonSchemaReq)).rejects.toMatchObject({ code: "PROVIDER" });

    // 1 + 2 retries, all native (a retryable PROVIDER exhausted does not fall back to the prompt).
    expect(generateTextMock).toHaveBeenCalledTimes(3);
  });

  it("ABORTED propagates immediately on the native path and neither retries nor falls back", async () => {
    generateTextMock.mockRejectedValue(Object.assign(new Error("abort"), { name: "AbortError" }));

    const llm = createAiSdkLlm(config, deps);
    await expect(llm.generateObject(jsonSchemaReq)).rejects.toMatchObject({ code: "ABORTED" });

    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it("generateText also retries a retryable PROVIDER", async () => {
    generateTextMock
      .mockRejectedValueOnce(apiError({ isRetryable: true, statusCode: 429 }))
      .mockResolvedValueOnce({ text: "hi", usage: {} });

    const llm = createAiSdkLlm(config, deps);
    const r = await llm.generateText({ prompt: "p" });

    expect(r.text).toBe("hi");
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(generateTextMock.mock.calls[0]![0]).toMatchObject({ maxRetries: 0 });
  });
});

describe("outputBudgetFactor (budget expansion for long-output calls)", () => {
  it("specifying factor expands maxOutputTokens to config × factor", async () => {
    generateTextMock.mockResolvedValueOnce({ output: { ok: true }, usage: {} });

    const llm = createAiSdkLlm(config, deps);
    await llm.generateObject({ ...jsonSchemaReq, outputBudgetFactor: 3 });

    expect(generateTextMock.mock.calls[0]![0]).toMatchObject({
      maxOutputTokens: config.maxOutputTokens * 3,
    });
  });

  it("does not apply the multiplier to a maxOutputTokens explicitly set by the caller", async () => {
    generateTextMock.mockResolvedValueOnce({ output: { ok: true }, usage: {} });

    const llm = createAiSdkLlm(config, deps);
    await llm.generateObject({ ...jsonSchemaReq, outputBudgetFactor: 3, maxOutputTokens: 2000 });

    expect(generateTextMock.mock.calls[0]![0]).toMatchObject({ maxOutputTokens: 2000 });
  });

  it("an invalid factor (0 / NaN) is treated as 1 (the unscaled default budget)", async () => {
    generateTextMock
      .mockResolvedValueOnce({ output: { ok: true }, usage: {} })
      .mockResolvedValueOnce({ output: { ok: true }, usage: {} });

    const llm = createAiSdkLlm(config, deps);
    await llm.generateObject({ ...jsonSchemaReq, outputBudgetFactor: 0 });
    await llm.generateObject({ ...jsonSchemaReq, outputBudgetFactor: Number.NaN });

    expect(generateTextMock.mock.calls[0]![0]).toMatchObject({
      maxOutputTokens: config.maxOutputTokens,
    });
    expect(generateTextMock.mock.calls[1]![0]).toMatchObject({
      maxOutputTokens: config.maxOutputTokens,
    });
  });

  it("the retry deadline is also expanded by factor", async () => {
    // A setup where the first backoff (70s) crosses the standard deadline (60s). Without factor, "waiting would
    // overrun the deadline" so it gives up retrying (fails in one attempt); factor 3 fits within the 180s deadline
    // so it retries (called twice).
    const cfg = resolveLlmEnv({
      KOHAKU_LLM_RETRY_MAX: "1",
      KOHAKU_LLM_RETRY_INITIAL_MS: "70000",
    });
    generateTextMock.mockRejectedValue(apiError({ isRetryable: true, statusCode: 503 }));
    const llm = createAiSdkLlm(cfg, deps);

    await expect(llm.generateObject(jsonSchemaReq)).rejects.toMatchObject({ code: "PROVIDER" });
    expect(generateTextMock).toHaveBeenCalledTimes(1);

    generateTextMock.mockClear();
    generateTextMock.mockRejectedValue(apiError({ isRetryable: true, statusCode: 503 }));
    await expect(llm.generateObject({ ...jsonSchemaReq, outputBudgetFactor: 3 })).rejects.toMatchObject({
      code: "PROVIDER",
    });
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it("the expanded maxOutputTokens carries over to the auto prompt JSON fallback too", async () => {
    generateTextMock
      .mockRejectedValueOnce(apiError({ isRetryable: false, statusCode: 400 }))
      .mockResolvedValueOnce({ text: JSON.stringify({ ok: 1 }), usage: {} });

    const llm = createAiSdkLlm(config, deps);
    await llm.generateObject({ ...jsonSchemaReq, outputBudgetFactor: 3 });

    // calls[0] is the native attempt (rejected); calls[1] is the prompt-JSON fallback.
    expect(generateTextMock.mock.calls[1]![0]).toMatchObject({
      maxOutputTokens: config.maxOutputTokens * 3,
    });
  });

  // Verify that factor also applies to maxOutputTokens and the deadline on the generateText path (used by L2's
  // raw HTML generation) (the previous test covered only the generateObject route; regression guard for the
  // inline implementation of ai-sdk.ts:generateText).
  it("generateText: specifying factor expands maxOutputTokens to config × factor", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "ok", usage: {} });

    const llm = createAiSdkLlm(config, deps);
    await llm.generateText({ prompt: "p", outputBudgetFactor: 3 });

    expect(generateTextMock.mock.calls[0]![0]).toMatchObject({
      maxOutputTokens: config.maxOutputTokens * 3,
    });
  });

  it("generateText: does not apply the multiplier to a maxOutputTokens explicitly set by the caller", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "ok", usage: {} });

    const llm = createAiSdkLlm(config, deps);
    await llm.generateText({ prompt: "p", outputBudgetFactor: 3, maxOutputTokens: 2000 });

    expect(generateTextMock.mock.calls[0]![0]).toMatchObject({ maxOutputTokens: 2000 });
  });

  it("generateText: an invalid factor (0 / NaN) is treated as 1 (the unscaled default budget)", async () => {
    generateTextMock
      .mockResolvedValueOnce({ text: "ok", usage: {} })
      .mockResolvedValueOnce({ text: "ok", usage: {} });

    const llm = createAiSdkLlm(config, deps);
    await llm.generateText({ prompt: "p", outputBudgetFactor: 0 });
    await llm.generateText({ prompt: "p", outputBudgetFactor: Number.NaN });

    expect(generateTextMock.mock.calls[0]![0]).toMatchObject({
      maxOutputTokens: config.maxOutputTokens,
    });
    expect(generateTextMock.mock.calls[1]![0]).toMatchObject({
      maxOutputTokens: config.maxOutputTokens,
    });
  });

  it("generateText: the retry deadline is also expanded by factor", async () => {
    // A setup where the first backoff (70s) crosses the standard deadline (60s). Without factor, "waiting would
    // overrun the deadline" so it gives up retrying (fails in one attempt); factor 3 fits within the 180s deadline
    // so it retries (called twice).
    const cfg = resolveLlmEnv({
      KOHAKU_LLM_RETRY_MAX: "1",
      KOHAKU_LLM_RETRY_INITIAL_MS: "70000",
    });
    generateTextMock.mockRejectedValue(apiError({ isRetryable: true, statusCode: 503 }));
    const llm = createAiSdkLlm(cfg, deps);

    await expect(llm.generateText({ prompt: "p" })).rejects.toMatchObject({ code: "PROVIDER" });
    expect(generateTextMock).toHaveBeenCalledTimes(1);

    generateTextMock.mockClear();
    generateTextMock.mockRejectedValue(apiError({ isRetryable: true, statusCode: 503 }));
    await expect(llm.generateText({ prompt: "p", outputBudgetFactor: 3 })).rejects.toMatchObject({
      code: "PROVIDER",
    });
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });
});

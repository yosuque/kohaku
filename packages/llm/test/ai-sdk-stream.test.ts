import { beforeEach, describe, expect, it, vi } from "vitest";

// Same vi.mock("ai") style as ai-sdk-retry.test.ts, extended with streamText so the streamObject adapter
// path (packages/llm/src/adapters/ai-sdk.ts, createAiSdkLlm().streamObject) can be exercised deterministically
// without a real provider. Since AI SDK 7, the native structured streaming call is streamText +
// output: Output.object(...) (the deprecated streamObject is no longer used by the adapter); the prompt-JSON
// fallback still goes through the shared generateText mock.
// These are characterization tests written BEFORE the Extract Function refactor of ai-sdk.ts (withPromptFallback
// / baseCallOptions / passing CallBudget whole) — they pin the current streamObject contract so the refactor
// (and, later, the AI SDK 7 migration) can be verified behavior-preserving by rerunning this file.
const { generateTextMock, streamTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  streamTextMock: vi.fn(),
}));

vi.mock("ai", () => ({
  generateText: (opts: unknown) => generateTextMock(opts),
  streamText: (opts: unknown) => streamTextMock(opts),
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

/** Builds a fake AI SDK streamText() return value: an async partialOutputStream plus resolved output/usage promises. */
function makeStream(
  partials: unknown[],
  finalObject: unknown,
  usage: { inputTokens?: number; outputTokens?: number },
) {
  return {
    partialOutputStream: (async function* () {
      for (const p of partials) yield p;
    })(),
    output: Promise.resolve(finalObject),
    usage: Promise.resolve(usage),
  };
}

const config = resolveLlmEnv({});
const deps = { sleep: async (): Promise<void> => {}, now: () => 0, random: () => 0.5 };
const jsonSchemaReq = { schema: { jsonSchema: { type: "object" } }, prompt: "p" } as const;

beforeEach(() => {
  generateTextMock.mockReset();
  streamTextMock.mockReset();
});

describe("createAiSdkLlm streamObject adapter", () => {
  it("onPartial receives cumulative partials in order, and the final object/usage match the resolved stream", async () => {
    const partials = [{ a: 1 }, { a: 1, b: 2 }];
    const final = { a: 1, b: 2 };
    streamTextMock.mockReturnValueOnce(makeStream(partials, final, { inputTokens: 3, outputTokens: 4 }));

    const llm = createAiSdkLlm(config, deps);
    const seen: unknown[] = [];
    const r = await llm.streamObject!({ ...jsonSchemaReq, onPartial: (p) => seen.push(p) });

    expect(seen).toEqual(partials);
    expect(r.object).toEqual(final);
    expect(r.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(r.model).toBe(config.model);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("a throwing onPartial is swallowed (port contract: a consumer exception must not break generation)", async () => {
    const partials = [{ a: 1 }, { a: 2 }];
    streamTextMock.mockReturnValueOnce(makeStream(partials, { a: 2 }, {}));

    const llm = createAiSdkLlm(config, deps);
    let calls = 0;
    const r = await llm.streamObject!({
      ...jsonSchemaReq,
      onPartial: () => {
        calls += 1;
        throw new Error("onPartial boom(test)");
      },
    });

    expect(calls).toBe(2); // called for every partial despite throwing each time
    expect(r.object).toEqual({ a: 2 }); // generation still completes and delivers the final object
  });

  it("when native structured mode fails with the prompt-fallback condition, the prompt path is used and no partial is emitted", async () => {
    // Non-retryable PROVIDER (structured 400, same condition as generateObject's fallback in ai-sdk-retry.test.ts).
    streamTextMock.mockImplementation(() => {
      throw apiError({ isRetryable: false, statusCode: 400 });
    });
    generateTextMock.mockResolvedValueOnce({
      text: JSON.stringify({ ok: 1 }),
      usage: { inputTokens: 5, outputTokens: 6 },
    });

    const llm = createAiSdkLlm(config, deps);
    const seen: unknown[] = [];
    const r = await llm.streamObject!({ ...jsonSchemaReq, onPartial: (p) => seen.push(p) });

    expect(seen).toEqual([]); // prompt-mode fallback does not stream (best-effort port contract)
    expect(r.object).toEqual({ ok: 1 });
    expect(streamTextMock).toHaveBeenCalledTimes(1); // no retry (non-retryable) before falling back
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock.mock.calls[0]![0]).toMatchObject({ maxRetries: 0 });
  });

  it("forwards maxRetries:0 and the budget-derived maxOutputTokens/abortSignal to the native streamText call", async () => {
    streamTextMock.mockReturnValueOnce(makeStream([], { ok: true }, {}));
    const controller = new AbortController();

    const llm = createAiSdkLlm(config, deps);
    await llm.streamObject!({
      ...jsonSchemaReq,
      onPartial: () => {},
      abort: controller.signal,
      maxOutputTokens: 555,
    });

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const call = streamTextMock.mock.calls[0]![0] as {
      maxRetries: number;
      maxOutputTokens: number;
      abortSignal: AbortSignal;
      temperature: number;
      prompt: string;
    };
    expect(call.maxRetries).toBe(0);
    expect(call.maxOutputTokens).toBe(555); // caller-supplied value, not multiplied by outputBudgetFactor
    expect(call.abortSignal).toBeInstanceOf(AbortSignal);
    expect(call.temperature).toBe(config.temperature);
    expect(call.prompt).toBe("p");
  });

  it("outputBudgetFactor expands maxOutputTokens the same way as generateObject", async () => {
    streamTextMock.mockReturnValueOnce(makeStream([], { ok: true }, {}));

    const llm = createAiSdkLlm(config, deps);
    await llm.streamObject!({ ...jsonSchemaReq, onPartial: () => {}, outputBudgetFactor: 3 });

    expect(streamTextMock.mock.calls[0]![0]).toMatchObject({
      maxOutputTokens: config.maxOutputTokens * 3,
    });
  });
});

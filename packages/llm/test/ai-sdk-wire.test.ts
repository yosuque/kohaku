import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAiSdkLlm } from "../src/adapters/ai-sdk.js";
import { type LlmConfig, resolveLlmEnv } from "../src/env.js";

/**
 * Wire-contract tests: the REAL provider SDKs (@ai-sdk/anthropic, @ai-sdk/openai-compatible, ...) run
 * unmocked and only the transport is replaced, via the test-only `LlmConfig.fetch` injection point. Tests that
 * mock "ai" or the provider factory (the rest of this directory) never see what actually goes on the wire —
 * which is how the python claude sampling-params bug (#104) went unnoticed.
 */

// The SDK logs a warning each time it drops `temperature` for claude-sonnet-5 (asserted below); keep the output clean.
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

interface Recorded {
  url: string;
  headers: Headers;
  json: Record<string, unknown>;
}

function recordingFetch(body: unknown): { calls: Recorded[]; fetchImpl: typeof globalThis.fetch } {
  const calls: Recorded[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    calls.push({
      url: req.url,
      headers: req.headers,
      json: (await req.clone().json()) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

/** The smallest valid Anthropic Messages API response: structured output arrives as JSON text. */
const ANTHROPIC_RESPONSE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content: [{ type: "text", text: '{"a":"x"}' }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 7 },
};

/** The smallest valid OpenAI Chat Completions response. */
const OPENAI_CHAT_RESPONSE = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 0,
  model: "gemma4:e4b",
  choices: [{ index: 0, message: { role: "assistant", content: '{"a":"x"}' }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
};

/** The smallest valid OpenAI Responses API response. */
const OPENAI_RESPONSES_RESPONSE = {
  id: "resp_1",
  object: "response",
  created_at: 0,
  status: "completed",
  model: "gpt-4.1",
  output: [
    {
      type: "message",
      id: "msg_1",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: '{"a":"x"}', annotations: [] }],
    },
  ],
  usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
};

/** The smallest valid Gemini generateContent response. */
const GEMINI_RESPONSE = {
  candidates: [
    { content: { role: "model", parts: [{ text: '{"a":"x"}' }] }, finishReason: "STOP", index: 0 },
  ],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 },
};

const REQ = { system: "s", prompt: "p", schema: z.object({ a: z.string() }), schemaName: "x" };
const deps = { sleep: async (): Promise<void> => {}, now: () => 0, random: () => 0.5 };

function config(
  env: Record<string, string>,
  fetchImpl: typeof globalThis.fetch,
  overrides: Partial<LlmConfig> = {},
): LlmConfig {
  return { ...resolveLlmEnv(env), structuredMode: "strict", fetch: fetchImpl, ...overrides };
}

describe("ai-sdk wire contract (real provider SDK, fake transport)", () => {
  it("claude: honours baseUrl, sends x-api-key and anthropic-version, no Authorization", async () => {
    const { calls, fetchImpl } = recordingFetch(ANTHROPIC_RESPONSE);
    const llm = createAiSdkLlm(
      config(
        {
          KOHAKU_LLM_PROVIDER: "claude",
          KOHAKU_LLM_API_KEY: "k",
          KOHAKU_LLM_BASE_URL: "https://gw.example/v1",
        },
        fetchImpl,
      ),
      deps,
    );
    const r = await llm.generateObject(REQ);
    expect(r.object).toEqual({ a: "x" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://gw.example/v1/messages");
    expect(calls[0]!.headers.get("x-api-key")).toBe("k");
    expect(calls[0]!.headers.get("anthropic-version")).toBeTruthy();
    expect(calls[0]!.headers.get("authorization")).toBeNull();
  });

  it("claude: without baseUrl the SDK default endpoint is used", async () => {
    const { calls, fetchImpl } = recordingFetch(ANTHROPIC_RESPONSE);
    const llm = createAiSdkLlm(
      config({ KOHAKU_LLM_PROVIDER: "claude", KOHAKU_LLM_API_KEY: "k" }, fetchImpl),
      deps,
    );
    await llm.generateObject(REQ);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("claude: the default model's request carries no sampling params (the SDK drops temperature for it)", async () => {
    // kohaku passes `temperature: 0` to the AI SDK, but @ai-sdk/anthropic omits it from the body for models that
    // reject sampling parameters (claude-sonnet-5 and later) and only logs a warning. This pins the wire result:
    // the Python port's ADR-0003 ("send no sampling params") already holds for the TS default model.
    const { calls, fetchImpl } = recordingFetch(ANTHROPIC_RESPONSE);
    const llm = createAiSdkLlm(
      config({ KOHAKU_LLM_PROVIDER: "claude", KOHAKU_LLM_API_KEY: "k" }, fetchImpl),
      deps,
    );
    await llm.generateObject(REQ);
    for (const key of ["temperature", "top_p", "top_k"]) expect(calls[0]!.json).not.toHaveProperty(key);
    expect(calls[0]!.json["max_tokens"]).toBe(4096);
  });

  it("ollama: sends Authorization: Bearer to baseUrl/chat/completions", async () => {
    const { calls, fetchImpl } = recordingFetch(OPENAI_CHAT_RESPONSE);
    const llm = createAiSdkLlm(
      config(
        {
          KOHAKU_LLM_PROVIDER: "ollama",
          KOHAKU_LLM_MODEL: "gemma4:e4b",
          KOHAKU_LLM_API_KEY: "k",
          KOHAKU_LLM_BASE_URL: "https://gw.example/v1",
        },
        fetchImpl,
      ),
      deps,
    );
    const r = await llm.generateObject(REQ);
    expect(r.object).toEqual({ a: "x" });
    expect(calls[0]!.url).toBe("https://gw.example/v1/chat/completions");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer k");
    expect(calls[0]!.headers.get("x-api-key")).toBeNull();
    expect(calls[0]!.json["model"]).toBe("gemma4:e4b");
  });

  it("llama: sends Authorization: Bearer to baseUrl/chat/completions", async () => {
    const { calls, fetchImpl } = recordingFetch(OPENAI_CHAT_RESPONSE);
    const llm = createAiSdkLlm(
      config(
        {
          KOHAKU_LLM_PROVIDER: "llama",
          KOHAKU_LLM_MODEL: "m",
          KOHAKU_LLM_API_KEY: "k",
          KOHAKU_LLM_BASE_URL: "http://llama.example:8080/v1",
        },
        fetchImpl,
      ),
      deps,
    );
    await llm.generateObject(REQ);
    expect(calls[0]!.url).toBe("http://llama.example:8080/v1/chat/completions");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer k");
  });

  it("openai: honours baseUrl and sends Authorization: Bearer to baseUrl/responses", async () => {
    const { calls, fetchImpl } = recordingFetch(OPENAI_RESPONSES_RESPONSE);
    const llm = createAiSdkLlm(
      config(
        {
          KOHAKU_LLM_PROVIDER: "openai",
          KOHAKU_LLM_API_KEY: "k",
          KOHAKU_LLM_BASE_URL: "https://gw.example/v1",
        },
        fetchImpl,
      ),
      deps,
    );
    const r = await llm.generateObject(REQ);
    expect(r.object).toEqual({ a: "x" });
    expect(calls[0]!.url).toBe("https://gw.example/v1/responses");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer k");
  });

  it("gemini: honours baseUrl and sends x-goog-api-key", async () => {
    const { calls, fetchImpl } = recordingFetch(GEMINI_RESPONSE);
    const llm = createAiSdkLlm(
      config(
        {
          KOHAKU_LLM_PROVIDER: "gemini",
          KOHAKU_LLM_API_KEY: "k",
          KOHAKU_LLM_BASE_URL: "https://gw.example/v1beta",
        },
        fetchImpl,
      ),
      deps,
    );
    const r = await llm.generateObject(REQ);
    expect(r.object).toEqual({ a: "x" });
    expect(calls[0]!.url.startsWith("https://gw.example/v1beta/")).toBe(true);
    expect(calls[0]!.headers.get("x-goog-api-key")).toBe("k");
  });
});

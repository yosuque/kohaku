import { beforeEach, describe, expect, it, vi } from "vitest";

// The provider SDKs (@ai-sdk/anthropic etc.) are optional peer dependencies (see packages/llm/package.json):
// a consumer that only configures, say, Claude does not install @ai-sdk/openai/@ai-sdk/google/
// @ai-sdk/openai-compatible at all. When the configured provider's SDK is missing, resolveModel's dynamic
// import() rejects with Node's own "Cannot find package" error (ERR_MODULE_NOT_FOUND); this test pins that
// resolveModel wraps that into a clear, actionable error instead of letting the raw Node error surface.
//
// vi.resetModules() + a fresh dynamic import of the adapter module (inside the test body, after vi.doMock)
// is required because vi.mock's static hoisting would apply the mock to every test in this file/run; doMock
// scopes the "package not found" simulation to this one test only.
//
// Note: Vitest's own module mocker re-throws a factory's thrown error wrapped in its own "[vitest] There
// was an error when mocking a module" Error, with the original (ERR_MODULE_NOT_FOUND) error attached as
// `.cause` rather than surfaced directly — this is why the adapter's importErrorCode() helper checks one
// level of `.cause` in addition to the error's own `.code`.
beforeEach(() => {
  vi.resetModules();
  vi.doMock("ai", () => ({
    generateText: vi.fn(),
    streamText: vi.fn(),
    jsonSchema: (s: unknown) => s,
    Output: { object: (opts: unknown) => opts },
  }));
});

describe("createAiSdkLlm: missing optional provider SDK", () => {
  it("produces a clear error naming both the missing package and @kohaku-ui/llm", async () => {
    vi.doMock("@ai-sdk/anthropic", () => {
      const e = new Error("Cannot find package '@ai-sdk/anthropic'");
      (e as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";
      throw e;
    });

    const { createAiSdkLlm } = await import("../src/adapters/ai-sdk.js");
    const { resolveLlmEnv } = await import("../src/env.js");

    const config = resolveLlmEnv({
      KOHAKU_LLM_PROVIDER: "claude",
      KOHAKU_LLM_MODEL: "claude-sonnet-5",
      ANTHROPIC_API_KEY: "test-key",
    });
    const llm = createAiSdkLlm(config);

    await expect(
      llm.generateObject({ schema: { jsonSchema: { type: "object" } }, prompt: "p" }),
    ).rejects.toThrow(/@ai-sdk\/anthropic.*@kohaku-ui\/llm/s);
    await expect(llm.generateText({ prompt: "p" })).rejects.toThrow(/@ai-sdk\/anthropic.*@kohaku-ui\/llm/s);
  });
});

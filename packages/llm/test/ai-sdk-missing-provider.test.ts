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

  // The installed @ai-sdk/anthropic package itself can fail to load with the very same
  // ERR_MODULE_NOT_FOUND code when one of ITS OWN transitive dependencies fails to resolve (a partial or
  // corrupted node_modules, a broken workspace link, a subpath-exports mismatch under an unexpected Node
  // version, etc.) — the peer dependency the caller was asked to configure is not the thing missing here.
  // importProvider must not misreport this as "install @ai-sdk/anthropic" (it is already installed); the
  // original error, naming the actually-missing module, must propagate unclassified instead.
  it("does not misreport an installed provider SDK's own broken transitive import as a missing peer", async () => {
    vi.doMock("@ai-sdk/anthropic", () => {
      // Shaped like Node's real ERR_MODULE_NOT_FOUND message for a failure *inside* an installed package:
      // the "imported from" clause names a path under the (installed, resolvable) @ai-sdk/anthropic
      // package itself — that substring must not be mistaken for "the @ai-sdk/anthropic peer is missing".
      const e = new Error(
        "Cannot find package 'some-transitive-dep' imported from " +
          "/repo/node_modules/@ai-sdk/anthropic/dist/index.js",
      );
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

    // The rejection must be the ORIGINAL error, not an LlmError re-diagnosing it as a missing peer.
    // (Not `.rejects.toThrow(regex)`: that matcher only inspects the rejected error's own top-level
    // `.message`, and — as documented at the top of this file — Vitest's module mocker re-throws a
    // factory's thrown error wrapped in its own generic message with the original attached as `.cause`, so
    // the real content here is one level down; the assertions below check both levels directly.)
    let caught: unknown;
    try {
      await llm.generateObject({ schema: { jsonSchema: { type: "object" } }, prompt: "p" });
    } catch (e) {
      caught = e;
    }
    const messages = [
      (caught as { message?: unknown })?.message,
      (caught as { cause?: { message?: unknown } })?.cause?.message,
    ];
    expect(messages.some((m) => typeof m === "string" && m.includes("some-transitive-dep"))).toBe(true);
    expect(
      messages.some((m) => typeof m === "string" && m.includes("needs the optional peer dependency")),
    ).toBe(false);
  });
});

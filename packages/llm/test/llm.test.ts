import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FakeLlm } from "../src/fake.js";
import { resolveLlmEnv } from "../src/index.js";

describe("resolveLlmEnv", () => {
  it("defaults to claude + the default model", () => {
    const config = resolveLlmEnv({});
    expect(config).toMatchObject({
      provider: "claude",
      model: "claude-sonnet-5",
      temperature: 0,
      maxOutputTokens: 4096,
    });
  });

  it("KOHAKU_LLM_API_KEY takes precedence over the provider standard key", () => {
    const config = resolveLlmEnv({
      KOHAKU_LLM_API_KEY: "kohaku-key",
      ANTHROPIC_API_KEY: "anthropic-key",
    });
    expect(config.apiKey).toBe("kohaku-key");
  });

  it("treats an empty-string (or whitespace-only) KOHAKU_LLM_API_KEY as unset, falling back to the provider standard key", () => {
    // `kohaku init`'s generated .env.example ships `KOHAKU_LLM_API_KEY=` uncommented as a placeholder;
    // after process.loadEnvFile that sets the var to "", which must not shadow ANTHROPIC_API_KEY.
    expect(resolveLlmEnv({ KOHAKU_LLM_API_KEY: "", ANTHROPIC_API_KEY: "anthropic-key" }).apiKey).toBe(
      "anthropic-key",
    );
    expect(resolveLlmEnv({ KOHAKU_LLM_API_KEY: "   ", ANTHROPIC_API_KEY: "anthropic-key" }).apiKey).toBe(
      "anthropic-key",
    );
  });

  it("treats an empty-string provider standard key as unset (no key configured)", () => {
    expect(resolveLlmEnv({ ANTHROPIC_API_KEY: "" }).apiKey).toBeUndefined();
  });

  it("ollama has a default baseUrl", () => {
    const config = resolveLlmEnv({ KOHAKU_LLM_PROVIDER: "ollama" });
    expect(config.baseUrl).toBe("http://localhost:11434/v1");
    expect(config.model).toBe("llama3.3");
  });

  it("llama requires BASE_URL and MODEL", () => {
    expect(() => resolveLlmEnv({ KOHAKU_LLM_PROVIDER: "llama" })).toThrow(/KOHAKU_LLM/);
    const config = resolveLlmEnv({
      KOHAKU_LLM_PROVIDER: "llama",
      KOHAKU_LLM_BASE_URL: "http://localhost:8080/v1",
      KOHAKU_LLM_MODEL: "qwen3-32b",
    });
    expect(config.model).toBe("qwen3-32b");
  });

  it("an invalid provider is a CONFIG error", () => {
    expect(() => resolveLlmEnv({ KOHAKU_LLM_PROVIDER: "gpt" })).toThrow(/must be one of/);
  });

  it("KOHAKU_LLM_TIMEOUT_MS defaults to 60000, allows only positive integers", () => {
    expect(resolveLlmEnv({}).timeoutMs).toBe(60000);
    expect(resolveLlmEnv({ KOHAKU_LLM_TIMEOUT_MS: "30000" }).timeoutMs).toBe(30000);
    expect(() => resolveLlmEnv({ KOHAKU_LLM_TIMEOUT_MS: "0" })).toThrow(/TIMEOUT_MS/);
    expect(() => resolveLlmEnv({ KOHAKU_LLM_TIMEOUT_MS: "abc" })).toThrow(/TIMEOUT_MS/);
  });

  it("warns when a key is unset for a key-required provider (no hard fail)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // claude (default) with no key → warns + config is still returned (no hard fail).
      const cfg = resolveLlmEnv({});
      expect(cfg.provider).toBe("claude");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("No API key configured");

      // Does not warn if a key is present.
      warn.mockClear();
      resolveLlmEnv({ ANTHROPIC_API_KEY: "k" });
      expect(warn).not.toHaveBeenCalled();

      // A key-not-required provider (ollama) does not warn even when unset.
      warn.mockClear();
      resolveLlmEnv({ KOHAKU_LLM_PROVIDER: "ollama" });
      expect(warn).not.toHaveBeenCalled();

      // An empty-string key is treated as unset, so it still warns.
      warn.mockClear();
      resolveLlmEnv({ ANTHROPIC_API_KEY: "" });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('KOHAKU_LLM_PROMPT_CACHE enables promptCache only for the exact string "1"', () => {
    // Contract (see env.ts's own doc on promptCache): any other truthy-looking string must NOT enable it.
    expect(resolveLlmEnv({}).promptCache).toBe(false);
    expect(resolveLlmEnv({ KOHAKU_LLM_PROMPT_CACHE: "1" }).promptCache).toBe(true);
    expect(resolveLlmEnv({ KOHAKU_LLM_PROMPT_CACHE: "0" }).promptCache).toBe(false);
    expect(resolveLlmEnv({ KOHAKU_LLM_PROMPT_CACHE: "true" }).promptCache).toBe(false);
    expect(resolveLlmEnv({ KOHAKU_LLM_PROMPT_CACHE: "" }).promptCache).toBe(false);
  });
});

describe("FakeLlm", () => {
  it("returns scripted responses in order and records calls", async () => {
    const fake = new FakeLlm({ objects: [{ a: 1 }, { a: 2 }] });
    const schema = z.object({ a: z.number() });
    const r1 = await fake.generateObject({ schema, prompt: "p1" });
    const r2 = await fake.generateObject({ schema, prompt: "p2", system: "s" });
    expect(r1.object).toEqual({ a: 1 });
    expect(r2.object).toEqual({ a: 2 });
    expect(fake.calls).toEqual([
      { kind: "object", prompt: "p1" },
      { kind: "object", prompt: "p2", system: "s" },
    ]);
  });

  it("INVALID_OUTPUT when a script does not match the schema", async () => {
    const fake = new FakeLlm({ objects: [{ a: "oops" }] });
    await expect(fake.generateObject({ schema: z.object({ a: z.number() }), prompt: "p" })).rejects.toThrow(
      /does not match schema/,
    );
  });

  it("passes JSON Schema input through as is (validation is the caller's)", async () => {
    const fake = new FakeLlm({ objects: [{ anything: true }] });
    const r = await fake.generateObject({
      schema: { jsonSchema: { type: "object" } },
      prompt: "p",
    });
    expect(r.object).toEqual({ anything: true });
  });
});

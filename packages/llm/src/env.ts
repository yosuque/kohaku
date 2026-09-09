import { LlmError } from "./port.js";

export type LlmProvider = "claude" | "openai" | "gemini" | "ollama" | "llama";

export type StructuredMode = "auto" | "strict" | "prompt";

/**
 * Retry policy for transient PROVIDER-side failures (rate limits, temporary outages).
 * Exponential backoff with jitter. Set maxRetries=0 to disable. See adapters/retry.ts for details.
 */
export interface RetryPolicy {
  /** Maximum number of retries (excluding the first attempt). 0 disables retries. */
  maxRetries: number;
  /** Initial backoff wait (milliseconds). */
  initialDelayMs: number;
  /** Backoff multiplier (base is multiplied per attempt). */
  backoffFactor: number;
  /** Jitter ratio (0..1). Perturbs base by ±jitter. */
  jitter: number;
}

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature: number;
  maxOutputTokens: number;
  /**
   * Structured-output mode.
   * auto: native structured output → fall back to prompt JSON on failure (default)
   * strict: native only / prompt: always prompt JSON (+ caller-side schema validation)
   * (ollama/llama.cpp can be unstable when compiling grammars for large schemas)
   */
  structuredMode: StructuredMode;
  /** Timeout for a single LLM call (milliseconds). Aborted via AbortSignal when exceeded. Default 60000. */
  timeoutMs: number;
  /** Retry policy for PROVIDER failures. The whole sequence never exceeds timeoutMs. */
  retry: RetryPolicy;
  /**
   * Opt-in Anthropic prompt caching (`cache_control`). Default false (KOHAKU_LLM_PROMPT_CACHE unset or
   * anything other than "1"). When true and the caller supplies GenerateObjectRequest/GenerateTextRequest's
   * `promptParts`, the ai-sdk adapter splits the `claude` provider's user message into two text parts and
   * marks the leading (`cacheable`) one with `providerOptions.anthropic.cacheControl = { type: "ephemeral" }`.
   * A no-op for every other provider (openai/gemini/ollama/llama) — they already do automatic prefix
   * caching, or (llama) have no equivalent — and a no-op when the caller passes no `promptParts` at all, so
   * turning this on changes nothing until both conditions are met. See docs/design.md §5 for the rationale
   * (kohaku's per-intent generation-schema enum defeats provider grammar caching; this is the separate,
   * complementary prompt-content cache).
   */
  promptCache: boolean;
}

/** Retry defaults (conservative). The backoff factor and jitter are not exposed via env; they are fixed constants. */
const DEFAULT_RETRY_MAX = 2;
const DEFAULT_RETRY_INITIAL_MS = 250;
const RETRY_BACKOFF_FACTOR = 2;
const RETRY_JITTER = 0.25;

const PROVIDERS: LlmProvider[] = ["claude", "openai", "gemini", "ollama", "llama"];

// claude: bumped from "claude-sonnet-4-6" to "claude-sonnet-5" (2026-09; confirmed present in the
// installed @ai-sdk/anthropic's AnthropicModelId union). Since the model id is part of
// defaultGeneratorVersion (prompt.ts), this changes the *default* cacheKey for any operator who never
// sets KOHAKU_LLM_MODEL: previously cached L0/L1/L2 entries for the default model miss exactly once after
// upgrading, then repopulate under the new model id. No in-repo test calls a real LLM (AGENTS.md), so
// nothing in the suite depends on this id's value — only that it resolves and round-trips through
// resolveLlmEnv/createAiSdkLlm. openai / gemini / ollama / llama are left untouched: their current model
// ids were not verified against primary sources as part of this change.
const DEFAULT_MODELS: Record<LlmProvider, string | null> = {
  claude: "claude-sonnet-5",
  openai: "gpt-4.1",
  gemini: "gemini-2.5-flash",
  ollama: "llama3.3",
  llama: null, // Required: the model name of the OpenAI-compatible endpoint must be specified.
};

/** Provider-standard API key environment variables (KOHAKU_LLM_API_KEY takes precedence). */
const STANDARD_KEY_ENV: Partial<Record<LlmProvider, string>> = {
  claude: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GOOGLE_GENERATIVE_AI_API_KEY",
};

export function resolveLlmEnv(env: Record<string, string | undefined> = process.env): LlmConfig {
  const provider = (env["KOHAKU_LLM_PROVIDER"] ?? "claude") as LlmProvider;
  if (!PROVIDERS.includes(provider)) {
    throw new LlmError(
      "CONFIG",
      `KOHAKU_LLM_PROVIDER must be one of ${PROVIDERS.join(", ")} (got "${provider}")`,
    );
  }

  const model = env["KOHAKU_LLM_MODEL"] ?? DEFAULT_MODELS[provider];
  if (model == null || model === "") {
    throw new LlmError("CONFIG", `KOHAKU_LLM_MODEL is required for provider "${provider}"`);
  }

  const standardKeyEnv = STANDARD_KEY_ENV[provider];
  const apiKey = env["KOHAKU_LLM_API_KEY"] ?? (standardKeyEnv != null ? env[standardKeyEnv] : undefined);
  // Warn if a key-required provider (claude/openai/gemini = those defined in STANDARD_KEY_ENV) has no key set
  // (onboarding aid; not a hard fail: the L0 deterministic path is designed to work without a key). console.warn
  // goes to stderr on Node, so it does not pollute the MCP stdio (stdout).
  if (standardKeyEnv != null && (apiKey == null || apiKey === "")) {
    console.warn(
      `[kohaku] No API key configured for LLM provider "${provider}" (set KOHAKU_LLM_API_KEY or ${standardKeyEnv}). ` +
        "The L0 deterministic path works, but L1/L2 generation requires a key.",
    );
  }

  let baseUrl = env["KOHAKU_LLM_BASE_URL"];
  if (provider === "ollama" && (baseUrl == null || baseUrl === "")) {
    baseUrl = "http://localhost:11434/v1";
  }
  if (provider === "llama" && (baseUrl == null || baseUrl === "")) {
    throw new LlmError(
      "CONFIG",
      'provider "llama" requires KOHAKU_LLM_BASE_URL (an OpenAI-compatible endpoint)',
    );
  }

  const temperature = Number(env["KOHAKU_LLM_TEMPERATURE"] ?? "0");
  const maxOutputTokens = Number(env["KOHAKU_LLM_MAX_OUTPUT_TOKENS"] ?? "4096");
  if (!Number.isFinite(temperature) || temperature < 0) {
    throw new LlmError("CONFIG", "KOHAKU_LLM_TEMPERATURE must be a non-negative number");
  }
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new LlmError("CONFIG", "KOHAKU_LLM_MAX_OUTPUT_TOKENS must be a positive integer");
  }

  const structuredMode = (env["KOHAKU_LLM_STRUCTURED_MODE"] ?? "auto") as StructuredMode;
  if (!["auto", "strict", "prompt"].includes(structuredMode)) {
    throw new LlmError("CONFIG", "KOHAKU_LLM_STRUCTURED_MODE must be auto | strict | prompt");
  }

  const timeoutMs = Number(env["KOHAKU_LLM_TIMEOUT_MS"] ?? "60000");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new LlmError("CONFIG", "KOHAKU_LLM_TIMEOUT_MS must be a positive integer (milliseconds)");
  }

  const maxRetries = Number(env["KOHAKU_LLM_RETRY_MAX"] ?? String(DEFAULT_RETRY_MAX));
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new LlmError("CONFIG", "KOHAKU_LLM_RETRY_MAX must be a non-negative integer (0 disables retries)");
  }
  const retryInitialMs = Number(env["KOHAKU_LLM_RETRY_INITIAL_MS"] ?? String(DEFAULT_RETRY_INITIAL_MS));
  if (!Number.isInteger(retryInitialMs) || retryInitialMs <= 0) {
    throw new LlmError("CONFIG", "KOHAKU_LLM_RETRY_INITIAL_MS must be a positive integer (milliseconds)");
  }

  // Opt-in, default off. Only "1" enables it (any other value, including unset, is off) — matching the
  // documented env contract exactly and avoiding surprising truthy-string parsing ("false" etc.).
  const promptCache = env["KOHAKU_LLM_PROMPT_CACHE"] === "1";

  return {
    provider,
    model,
    apiKey,
    baseUrl,
    temperature,
    maxOutputTokens,
    structuredMode,
    timeoutMs,
    retry: {
      maxRetries,
      initialDelayMs: retryInitialMs,
      backoffFactor: RETRY_BACKOFF_FACTOR,
      jitter: RETRY_JITTER,
    },
    promptCache,
  };
}

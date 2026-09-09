import { createAiSdkLlm } from "./adapters/ai-sdk.js";
import { type LlmConfig, resolveLlmEnv } from "./env.js";
import type { LlmPort } from "./port.js";

export function createLlm(config: LlmConfig): LlmPort {
  return createAiSdkLlm(config);
}

/** Builds an LlmPort from environment variables (KOHAKU_LLM_*). */
export function createLlmFromEnv(env: Record<string, string | undefined> = process.env): LlmPort {
  return createLlm(resolveLlmEnv(env));
}

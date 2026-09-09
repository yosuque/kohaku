import type { z } from "zod";

/**
 * Provider-agnostic LLM contract. The internal implementation (Vercel AI SDK) is isolated in a single
 * adapter file, and the composer / evals / SemanticPort implementations depend only on this Port.
 */

/** A Zod schema, or a raw JSON Schema dynamically built by the registry. */
export type SchemaInput<T> = z.ZodType<T> | { jsonSchema: Record<string, unknown> };

/**
 * An optional split of `prompt` into a leading `cacheable` part and a trailing `rest` part, for
 * providers with explicit prompt caching (Anthropic's `cache_control`). **Invariant:
 * `cacheable + rest === prompt`** — callers must construct both from the same content that produces
 * `prompt`, never as independently-computed strings, so the invariant is expected to hold by construction
 * at every call site. It is still a caller contract rather than something this type can enforce, so a
 * cache-capable adapter re-checks it defensively at the point of use (`cacheable + rest !== prompt`) and
 * falls back to sending the plain `prompt` string when it does not hold, rather than trusting a caller-side
 * bug to send mismatched content to the model. Purely additive: FakeLlm / FixtureLlm (and any LlmPort that
 * does not implement caching) ignore this field and read `prompt` as before, so passing it changes nothing
 * unless the adapter is both cache-capable and opted in (see LlmConfig.promptCache in @kohaku-ui/llm's env).
 * `cacheable` is expected to be the part that stays byte-identical across a run of calls that share it
 * (e.g. the composer's repair loop re-issuing the same static prompt prefix with only the trailing
 * repair-feedback section changing), so a provider that keys its cache on exact prefix bytes can reuse
 * the compiled/attended prefix instead of reprocessing it on every call.
 */
export interface PromptParts {
  cacheable: string;
  rest: string;
}

/**
 * Adaptive Reasoning effort level (Claude 4.6+/5's replacement for fixed thinking-token budgets; see
 * `adapters/ai-sdk.ts`'s `resolveProviderOptions` for the per-provider wiring and which providers ignore
 * it). Five levels from least to most reasoning effort spent before answering.
 */
export type LlmEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface GenerateObjectRequest<T> {
  schema: SchemaInput<T>;
  schemaName?: string;
  system?: string;
  prompt: string;
  /** See `PromptParts`'s doc. Optional; omitted entirely when the caller has no natural cache boundary. */
  promptParts?: PromptParts;
  /** Default 0 (aids determinism; the actual guarantee is provided by the cache). */
  temperature?: number;
  maxOutputTokens?: number;
  abort?: AbortSignal;
  /**
   * Output-budget multiplier (≥1, default 1). Scales this call's timeout (KOHAKU_LLM_TIMEOUT_MS) and,
   * when maxOutputTokens is not explicitly given, the output-token limit (KOHAKU_LLM_MAX_OUTPUT_TOKENS)
   * to the environment setting × this multiplier. Prevents a call with an order-of-magnitude longer output
   * — such as L2 free-form generation (full HTML) versus the standard (small L1 JSON) — from sharing the same
   * single-call budget and running out on the time/token limit first (observed: local ollama's L2 generation
   * falls into ABORTED at the default 60s boundary). Invalid values (NaN / less than 1) are treated as 1.
   */
  outputBudgetFactor?: number;
  /**
   * How much the model should reason before answering (optional; a port that does not implement effort
   * control ignores this field — FakeLlm/FixtureLlm and every non-Anthropic-matching adapter path leave
   * behavior unchanged). Omitted entirely means "provider default." See `LlmEffort`'s doc and
   * `adapters/ai-sdk.ts`'s `resolveProviderOptions` for which providers this actually reaches and under
   * which provider-options field.
   */
  effort?: LlmEffort;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface GenerateObjectResult<T> {
  object: T;
  usage: LlmUsage;
  model: string;
}

export interface GenerateTextRequest {
  system?: string;
  prompt: string;
  /** See `PromptParts`'s doc (same contract as GenerateObjectRequest.promptParts). */
  promptParts?: PromptParts;
  temperature?: number;
  maxOutputTokens?: number;
  abort?: AbortSignal;
  /** Output-budget multiplier (≥1, default 1). Same meaning as GenerateObjectRequest.outputBudgetFactor. */
  outputBudgetFactor?: number;
  /** Same meaning and same "ignored if unsupported" contract as GenerateObjectRequest.effort. */
  effort?: LlmEffort;
}

export interface LlmPort {
  readonly provider: string;
  readonly modelId: string;
  generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>>;
  generateText(req: GenerateTextRequest): Promise<{ text: string; usage: LlmUsage }>;
  /**
   * Streaming structured-output generation (optional). Notifies the **cumulative partial object** during
   * generation via onPartial, while returning the same validated object as generateObject as the final result.
   *
   * Contract:
   * - partial is best-effort. It may never be called at all (e.g. under the prompt JSON fallback).
   * - Each onPartial is "the cumulative form up to that point" — the consumer must rebuild from scratch every
   *   time (so it stays safe even when a provider retry resends from the beginning). A throw from onPartial is
   *   swallowed (it does not break generation).
   * - On a port with no implementation, the caller must fall back to generateObject (behaviorally equivalent, no partials).
   */
  streamObject?<T>(
    req: GenerateObjectRequest<T> & { onPartial: (partial: unknown) => void },
  ): Promise<GenerateObjectResult<T>>;
}

export type LlmErrorCode = "CONFIG" | "INVALID_OUTPUT" | "PROVIDER" | "ABORTED";

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly provider?: string;
  readonly modelId?: string;

  constructor(
    code: LlmErrorCode,
    message: string,
    opts: { provider?: string; modelId?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "LlmError";
    this.code = code;
    this.provider = opts.provider;
    this.modelId = opts.modelId;
  }
}

export function isZodSchema<T>(schema: SchemaInput<T>): schema is z.ZodType<T> {
  return typeof (schema as { safeParse?: unknown }).safeParse === "function";
}

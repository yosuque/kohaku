/**
 * Isolates the connection to the Vercel AI SDK in this single file.
 * SDK major-version churn (the evolution of the generateObject family of APIs, now the Output API on
 * generateText/streamText as of AI SDK 7) is absorbed only here, keeping LlmPort as an invariant contract.
 */
import {
  generateText,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  Output,
  streamText,
  type TextPart,
} from "ai";
import { z } from "zod";
import type { LlmConfig, StructuredMode } from "../env.js";
import {
  type GenerateObjectRequest,
  type GenerateObjectResult,
  type GenerateTextRequest,
  isZodSchema,
  type LlmEffort,
  LlmError,
  type LlmPort,
  type LlmUsage,
  type PromptParts,
} from "../port.js";
import { defaultRetryDeps, isRetryableProviderError, type RetryDeps, withProviderRetry } from "./retry.js";

async function resolveModel(config: LlmConfig): Promise<LanguageModel> {
  switch (config.provider) {
    case "claude": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return createAnthropic({ ...(config.apiKey != null ? { apiKey: config.apiKey } : {}) })(config.model);
    }
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({ ...(config.apiKey != null ? { apiKey: config.apiKey } : {}) })(config.model);
    }
    case "gemini": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      return createGoogleGenerativeAI({
        ...(config.apiKey != null ? { apiKey: config.apiKey } : {}),
      })(config.model);
    }
    case "ollama":
    case "llama": {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      return createOpenAICompatible({
        name: config.provider,
        baseURL: config.baseUrl!,
        apiKey: config.apiKey ?? "not-required",
        // When this is false (the default), no JSON Schema is sent and the model generates free-form JSON
        // that fails validation. The /v1 endpoints of ollama / llama.cpp already support json_schema.
        supportsStructuredOutputs: true,
      }).chatModel(config.model);
    }
  }
}

/**
 * An AbortSignal composed from the caller's abort and a timeout.
 * Always passing this ensures that even if a provider (especially local ollama / llama.cpp) stalls with no
 * response, it is aborted at the time limit, preventing the /compose handler from holding a socket indefinitely.
 */
function resolveSignal(req: { abort?: AbortSignal }, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return req.abort != null ? AbortSignal.any([req.abort, timeout]) : timeout;
}

/** Normalizes outputBudgetFactor. Invalid values (non-number / less than 1) are dropped to 1 (= the unscaled default budget). */
function normalizeBudgetFactor(factor: number | undefined): number {
  return typeof factor === "number" && Number.isFinite(factor) && factor >= 1 ? factor : 1;
}

/**
 * The output budget (time / tokens) plus the shared signal/deadline for one logical LlmPort call
 * (computeBudget's return shape, named so it can be threaded as a single value — see baseCallOptions and
 * generateViaPrompt, which both take the whole object instead of its fields positionally).
 */
interface CallBudget {
  timeoutMs: number;
  maxOutputTokens: number;
  signal: AbortSignal;
  deadline: number;
}

/**
 * Determines the output budget (time / tokens), signal, and deadline together.
 * maxOutputTokens respects the caller's explicit value if given, and the multiplier is not applied.
 * The signal is created only once at the call entry point and shared between the native attempt and the auto
 * fallback's prompt attempt (calling resolveSignal per attempt would create a fresh timeout, potentially
 * stalling for up to 2×timeoutMs across the two stages). The deadline is shared by both backoffs too so that,
 * even combined, they never exceed timeoutMs (upholding "one call = at most timeoutMs").
 */
function computeBudget(
  req: { outputBudgetFactor?: number; maxOutputTokens?: number; abort?: AbortSignal },
  config: LlmConfig,
  retryDeps: RetryDeps,
): CallBudget {
  const factor = normalizeBudgetFactor(req.outputBudgetFactor);
  const timeoutMs = config.timeoutMs * factor;
  const maxOutputTokens = req.maxOutputTokens ?? Math.round(config.maxOutputTokens * factor);
  const signal = resolveSignal(req, timeoutMs);
  const deadline = retryDeps.now() + timeoutMs;
  return { timeoutMs, maxOutputTokens, signal, deadline };
}

/** Normalizes AI SDK usage (both fields optional on their side) into LlmPort's LlmUsage (both required, 0-defaulted). Pure, so module-scope. */
function toUsage(usage: { inputTokens?: number; outputTokens?: number } | undefined): LlmUsage {
  return { inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 };
}

/**
 * Resolves the `prompt` call-option: the plain string (conventional, always the case unless prompt
 * caching is both enabled and applicable) or, when Anthropic prompt caching applies, a one-message
 * `ModelMessage[]` whose user content is split into the `promptParts.cacheable` text (marked with
 * `providerOptions.anthropic.cacheControl = { type: "ephemeral" }`) followed by the `promptParts.rest`
 * text.
 *
 * Gated on all of: `config.promptCache` (opt-in, default off — KOHAKU_LLM_PROMPT_CACHE=1),
 * `config.provider === "claude"` (OpenAI/Gemini already do automatic prefix caching; "ollama"/"llama"
 * have no equivalent mechanism this adapter knows how to address — so this is a no-op for every other
 * provider regardless of the flag), and `req.promptParts` being present with a non-empty `cacheable`
 * (nothing to mark as cacheable otherwise). As a last defense of the port's `cacheable + rest === prompt`
 * invariant, a caller-side inconsistency (a bug upstream) falls back to the plain string rather than
 * silently sending different content than `req.prompt` to the model.
 */
function resolvePromptInput(
  req: { prompt: string; promptParts?: PromptParts },
  config: LlmConfig,
): string | ModelMessage[] {
  if (!config.promptCache || config.provider !== "claude") return req.prompt;
  const parts = req.promptParts;
  if (parts == null || parts.cacheable === "" || parts.cacheable + parts.rest !== req.prompt) {
    return req.prompt;
  }
  const content: TextPart[] = [
    {
      type: "text",
      text: parts.cacheable,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
  ];
  if (parts.rest !== "") content.push({ type: "text", text: parts.rest });
  return [{ role: "user", content }];
}

/**
 * Resolves the AI SDK `providerOptions` object carrying `req.effort` (Adaptive Reasoning), translated to
 * each provider's own field name/namespace. Returns undefined when `req.effort` is unset (no `providerOptions`
 * key is added at all — byte-identical to before this field existed) or when the provider has no matching
 * option (gemini).
 *
 * - **claude**: `providerOptions.anthropic.effort`. Verified against the installed @ai-sdk/anthropic's
 *   `dist/index.d.ts`/`dist/index.js`: `effort` appears on *two* distinct provider-options objects —
 *   `anthropicSystemMessageProviderOptions` (a *different* feature: changing effort mid-conversation via a
 *   system message, gated behind the `mid-conversation-effort-2026-08-01` beta) and
 *   `anthropicLanguageModelOptions` (the plain per-request language-model option). Only the latter is read
 *   at the request-building call site and forwarded as `output_config: { effort }` in the API request body
 *   — that is the one this adapter sets, under the `anthropic` provider-options key (not a system message).
 * - **openai**: `providerOptions.openai.reasoningEffort`. `resolveModel`'s `createOpenAI(...)(config.model)`
 *   call form resolves to the Responses API model (`OpenAIResponsesModelId`/`languageModel`, not the
 *   legacy Chat Completions model), whose provider-options schema
 *   (`openaiLanguageModelResponsesOptionsSchema`) declares `reasoningEffort` (typed as a plain string on
 *   that schema, but every `LlmEffort` value is a valid OpenAI reasoning-effort level).
 * - **ollama / llama** (via `@ai-sdk/openai-compatible`): `providerOptions.openaiCompatible.reasoningEffort`.
 *   The compatible chat model reads provider options under the `openaiCompatible` key (in addition to the
 *   raw/camelCased provider name it was constructed with), so this single key reaches both providers
 *   regardless of which one `config.provider` names. Whether the underlying endpoint actually honors this
 *   OpenAI-shaped field depends on the endpoint (vLLM/llama.cpp-style OpenAI-compatible servers commonly
 *   do; a plain endpoint that does not recognize it simply ignores the extra request field).
 * - **gemini**: no equivalent effort-*level* option exists in the installed @ai-sdk/google — only a
 *   numeric `thinkingConfig.thinkingBudget` (a token count, not a level, and not an obvious 1:1 mapping
 *   from `LlmEffort`), so `req.effort` is silently ignored for this provider (no `providerOptions` set).
 */
function resolveProviderOptions(
  req: { effort?: LlmEffort },
  config: LlmConfig,
): Record<string, Record<string, string>> | undefined {
  if (req.effort == null) return undefined;
  switch (config.provider) {
    case "claude":
      return { anthropic: { effort: req.effort } };
    case "openai":
      return { openai: { reasoningEffort: req.effort } };
    case "ollama":
    case "llama":
      return { openaiCompatible: { reasoningEffort: req.effort } };
    case "gemini":
      return undefined;
  }
}

/**
 * The AI SDK call-option fields shared by every native/prompt call this adapter makes (the structured
 * generateText+Output.object call, the streamText+Output.object call, and both plain generateText call
 * sites) — model, an optional instructions (AI SDK 7's rename of `system`; same downstream system-message
 * construction, so this is a field-name translation only and does not change the bytes sent to the model),
 * the prompt (see resolvePromptInput — a plain string unless Anthropic prompt caching applies), temperature
 * (falling back to config default), the budget-derived maxOutputTokens/abortSignal, and maxRetries:0 (the
 * SDK's own retry is always disabled; retries are centralized in withProviderRetry to avoid an SDK×llm
 * double-retry blowing up the wait time). The two structured calls additionally spread in
 * `output: Output.object(...)` on top of this via buildObjectOutput — this helper only covers the fields
 * identical across all four call sites.
 *
 * Also spreads in `providerOptions` (see resolveProviderOptions) when `req.effort` is set and the
 * provider has a matching option — omitted entirely otherwise, so a call that never sets `effort` sends
 * exactly the same request shape as before this field existed.
 */
function baseCallOptions(
  model: LanguageModel,
  req: {
    system?: string;
    prompt: string;
    promptParts?: PromptParts;
    temperature?: number;
    effort?: LlmEffort;
  },
  config: LlmConfig,
  budget: CallBudget,
) {
  const providerOptions = resolveProviderOptions(req, config);
  return {
    model,
    ...(req.system != null ? { instructions: req.system } : {}),
    prompt: resolvePromptInput(req, config),
    temperature: req.temperature ?? config.temperature,
    maxOutputTokens: budget.maxOutputTokens,
    abortSignal: budget.signal,
    // Retries are centrally managed in the llm layer (withProviderRetry). Disabled here because
    // combining the SDK's built-in exponential backoff (default maxRetries=2) would cause an
    // SDK×llm double retry and blow up the wait time.
    maxRetries: 0,
    ...(providerOptions != null ? { providerOptions } : {}),
  };
}

/**
 * Decides whether it is OK to proceed to the prompt JSON fallback. If not, throws the already-wrapped error.
 * strict fails immediately. Even under auto, an abort (ABORTED) means a caller/user cancellation or a timeout
 * overrun, so it propagates immediately without re-calling in prompt mode (avoiding needless retries after an
 * abort; the shared signal has already expired).
 * A failure that has exhausted retries against a transient PROVIDER (429/5xx) will not be resolved by the same
 * provider's prompt mode either. The prompt fallback exists to rescue structured-output instability (ollama's
 * grammar 400 = non-retryable PROVIDER) and INVALID_OUTPUT, so when a retryable PROVIDER is exhausted it does
 * not fall back but propagates immediately.
 * auto: otherwise, the caller retries once with prompt JSON.
 */
function rethrowUnlessPromptFallback(cause: unknown, mode: StructuredMode, config: LlmConfig): void {
  const wrapped = wrapError(cause, config);
  if (mode === "strict" || wrapped.code === "ABORTED") throw wrapped;
  if (wrapped.code === "PROVIDER" && isRetryableProviderError(cause)) throw wrapped;
}

/** Resolves the AI SDK's schema argument (Zod is passed through / a raw JSON Schema is wrapped with jsonSchema()). */
function resolveSchemaArg<T>(req: GenerateObjectRequest<T>) {
  return isZodSchema(req.schema) ? req.schema : jsonSchema<T>(req.schema.jsonSchema);
}

/**
 * Builds the `output: Output.object({ schema, name })` value shared by the structured generateText and
 * streamText call sites (AI SDK 7's replacement for the deprecated generateObject/streamObject `schema`/
 * `schemaName` options).
 */
function buildObjectOutput<T>(req: GenerateObjectRequest<T>) {
  return Output.object<T>({
    schema: resolveSchemaArg(req),
    ...(req.schemaName != null ? { name: req.schemaName } : {}),
  });
}

/**
 * The shared "native structured call → rethrowUnlessPromptFallback → prompt fallback" skeleton behind both
 * the structured generateText and streamText calls. `native` performs one structured-mode attempt (already
 * wrapped in withProviderRetry by the caller) and resolves with the AI SDK's raw `{ object, usage }`;
 * `fallback` performs the prompt-JSON attempt (generateViaPrompt) when structured mode is skipped
 * (`mode === "prompt"`) or the native attempt fails in a way rethrowUnlessPromptFallback allows to fall
 * through (a rethrow from that call propagates out of this function, matching the pre-refactor try/catch's
 * rethrow-and-exit).
 */
async function withPromptFallback<T>(
  config: LlmConfig,
  mode: StructuredMode,
  native: () => Promise<{
    object: unknown;
    usage: { inputTokens?: number; outputTokens?: number } | undefined;
  }>,
  fallback: () => Promise<GenerateObjectResult<T>>,
): Promise<GenerateObjectResult<T>> {
  if (mode !== "prompt") {
    try {
      const result = await native();
      return { object: result.object as T, usage: toUsage(result.usage), model: config.model };
    } catch (cause) {
      rethrowUnlessPromptFallback(cause, mode, config);
    }
  }
  return fallback();
}

export function createAiSdkLlm(config: LlmConfig, deps: Partial<RetryDeps> = {}): LlmPort {
  let modelPromise: Promise<LanguageModel> | undefined;
  // Discard the cached promise on rejection (mirroring the AllowedActions cache's own convention — see
  // host-core's createAllowedActions) so a transient model-resolution failure (a momentary network blip
  // fetching provider metadata, etc.) does not permanently wedge every subsequent call on this LlmPort
  // instance into re-throwing the same stale rejection; the next call gets a fresh resolveModel() attempt.
  // A successful resolution is still cached forever, matching the previous behavior exactly.
  const getModel = (): Promise<LanguageModel> => {
    if (modelPromise == null) {
      modelPromise = resolveModel(config).catch((e: unknown) => {
        modelPromise = undefined;
        throw e;
      });
    }
    return modelPromise;
  };
  // Retry side effects (wait / time / randomness) default to the implementation and are swapped only in tests.
  const retryDeps: RetryDeps = { ...defaultRetryDeps, ...deps };

  return {
    provider: config.provider,
    modelId: config.model,

    async generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
      const model = await getModel();
      const mode = config.structuredMode ?? "auto";
      const budget = computeBudget(req, config, retryDeps);

      return withPromptFallback<T>(
        config,
        mode,
        async () => {
          // generateText + output: Output.object(...) is AI SDK 7's replacement for the deprecated
          // generateObject. A schema parse/validation failure surfaces as the generateText() call itself
          // rejecting with AI_NoObjectGeneratedError (Output.object's parseCompleteOutput is awaited inside
          // generateText's own try/catch), so by the time this resolves, `.output` is safe to read directly.
          const result = await withProviderRetry(
            () =>
              generateText({
                ...baseCallOptions(model, req, config, budget),
                output: buildObjectOutput(req),
              }),
            { policy: config.retry, signal: budget.signal, deadline: budget.deadline, deps: retryDeps },
          );
          return { object: result.output, usage: result.usage };
        },
        () => generateViaPrompt(model, req, config, budget, retryDeps),
      );
    },

    async streamObject<T>(
      req: GenerateObjectRequest<T> & { onPartial: (partial: unknown) => void },
    ): Promise<GenerateObjectResult<T>> {
      const model = await getModel();
      const mode = config.structuredMode ?? "auto";
      // The budget / signal / deadline assembly is identical to generateObject (one call = at most timeoutMs).
      const budget = computeBudget(req, config, retryDeps);

      return withPromptFallback<T>(
        config,
        mode,
        () =>
          withProviderRetry(
            async () => {
              // streamText + output: Output.object(...) is AI SDK 7's replacement for the deprecated
              // streamObject: partialOutputStream carries the unvalidated cumulative form (same shape as the
              // old partialObjectStream — DeepPartial<T>), and the final `.output` is validated (a validation
              // failure rejects .output = AI_NoObjectGeneratedError → INVALID_OUTPUT).
              // Because withProviderRetry retries this entire thunk, on retry the partials are resent from the
              // beginning (port contract: the consumer rebuilds from scratch every time).
              const stream = streamText({
                ...baseCallOptions(model, req, config, budget),
                output: buildObjectOutput(req),
              });
              for await (const partial of stream.partialOutputStream) {
                try {
                  req.onPartial(partial);
                } catch {
                  // A consumer exception (assembling the provisional display) must not break the generation itself (port contract).
                }
              }
              const [object, usage] = await Promise.all([stream.output, stream.usage]);
              return { object, usage };
            },
            { policy: config.retry, signal: budget.signal, deadline: budget.deadline, deps: retryDeps },
          ),
        // Prompt JSON mode does not stream (no partial notifications = the port contract's best-effort).
        () => generateViaPrompt(model, req, config, budget, retryDeps),
      );
    },

    async generateText(req: GenerateTextRequest) {
      const model = await getModel();
      // Same budget expansion as generateObject (L2's raw HTML generation uses the generateText path).
      const budget = computeBudget(req, config, retryDeps);
      try {
        const result = await withProviderRetry(
          () => generateText(baseCallOptions(model, req, config, budget)),
          { policy: config.retry, signal: budget.signal, deadline: budget.deadline, deps: retryDeps },
        );
        return { text: result.text, usage: toUsage(result.usage) };
      } catch (cause) {
        throw wrapError(cause, config);
      }
    },
  };
}

/**
 * Prompt JSON mode: attaches the schema to the prompt, generates plain text, extracts the JSON, and
 * validates it (if a Zod schema). An escape hatch for endpoints that do not support structured output or are
 * unstable. Final validation is also handled by the caller (the composer's repair loop).
 */
async function generateViaPrompt<T>(
  model: LanguageModel,
  req: GenerateObjectRequest<T>,
  config: LlmConfig,
  // The whole budget (maxOutputTokens/signal/deadline) computed once by the caller (generateObject/
  // streamObject) and shared between the native attempt and this prompt fallback, so that together they
  // never exceed a single call's timeoutMs.
  budget: CallBudget,
  retryDeps: RetryDeps,
): Promise<GenerateObjectResult<T>> {
  const schemaJson = isZodSchema(req.schema)
    ? JSON.stringify(z.toJSONSchema(req.schema as z.ZodType, { reused: "inline" }))
    : JSON.stringify(req.schema.jsonSchema);

  try {
    const result = await withProviderRetry(
      () =>
        generateText({
          // baseCallOptions spreads in resolvePromptInput(req, config) as `prompt`, but it is immediately
          // overwritten below by the schema-appended plain string. So `req.promptParts` is never threaded
          // through here: prompt caching deliberately does not apply on this fallback path (matching the
          // Python port's `_generate_via_prompt`, which documents the same at adapters/_base.py's
          // `_text_once` — its schema-appended prompt does not satisfy the `cacheable + rest === prompt`
          // invariant against `req.prompt` either).
          ...baseCallOptions(model, req, config, budget),
          prompt: [
            req.prompt,
            "## Output format",
            "Output only a JSON object that strictly conforms to the following JSON Schema.",
            "Do not output any explanatory text, code fences, or any text other than the JSON.",
            schemaJson,
          ].join("\n\n"),
        }),
      { policy: config.retry, signal: budget.signal, deadline: budget.deadline, deps: retryDeps },
    );

    const text = extractJson(result.text);
    let object: unknown;
    try {
      object = JSON.parse(text);
    } catch {
      throw new LlmError("INVALID_OUTPUT", "prompt-mode output is not valid JSON", {
        provider: config.provider,
        modelId: config.model,
      });
    }
    if (isZodSchema(req.schema)) {
      const parsed = req.schema.safeParse(object);
      if (!parsed.success) {
        throw new LlmError(
          "INVALID_OUTPUT",
          `prompt-mode output does not match schema: ${parsed.error.message.slice(0, 300)}`,
          { provider: config.provider, modelId: config.model },
        );
      }
      return { object: parsed.data, usage: toUsage(result.usage), model: config.model };
    }
    return { object: object as T, usage: toUsage(result.usage), model: config.model };
  } catch (cause) {
    if (cause instanceof LlmError) throw cause;
    throw wrapError(cause, config);
  }
}

/** Strips code fences and surrounding text to extract the JSON body. */
function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced != null ? fenced[1]! : text).trim();
  // First try parsing the whole thing directly. In the normal case where the model output only JSON as
  // instructed, this settles it here. This avoids both mis-extraction from a `{` in preamble text (e.g.
  // `{variable}`) and dropping a top-level array `[...]` (placing it before the bracket-slicing stage is key).
  try {
    JSON.parse(body);
    return body;
  } catch {
    // Fallback when text is mixed in before/after. Use whichever of `{` and `[` appears earlier as the start,
    // and slice up to the last position of the corresponding closing bracket (handles both objects and arrays).
    const objStart = body.indexOf("{");
    const arrStart = body.indexOf("[");
    const useArray = arrStart >= 0 && (objStart < 0 || arrStart < objStart);
    const start = useArray ? arrStart : objStart;
    const end = useArray ? body.lastIndexOf("]") : body.lastIndexOf("}");
    return start >= 0 && end > start ? body.slice(start, end + 1) : body;
  }
}

function wrapError(cause: unknown, config: LlmConfig): LlmError {
  const name = (cause as { name?: string })?.name ?? "";
  const message = cause instanceof Error ? cause.message : String(cause);
  const code =
    // AI_NoObjectGeneratedError: Output.object's parseCompleteOutput failed to parse/validate the model's
    // text (thrown from inside generateText/streamText's own await, propagating as the call's rejection).
    // AI_NoOutputGeneratedError: no output could be computed at all (e.g. the final step ended in
    // "tool-calls" or produced no text), surfaced via the `.output` getter/promise. Both mean "no valid
    // structured output was produced" from LlmPort's point of view.
    name === "AI_NoObjectGeneratedError" || name === "AI_NoOutputGeneratedError"
      ? "INVALID_OUTPUT"
      : name === "AbortError" || name === "TimeoutError"
        ? "ABORTED"
        : "PROVIDER";
  return new LlmError(code, `[${config.provider}/${config.model}] ${message}`, {
    provider: config.provider,
    modelId: config.model,
    cause,
  });
}

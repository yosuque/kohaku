import { LlmError, type LlmPort } from "@kohaku-ui/llm";
import type { JsonObject, NLQuery } from "@kohaku-ui/spec-core";
import { z } from "zod";
import type { IntentCatalogLike } from "./catalog.js";
import { buildNormalizeSystemPrompt, buildNormalizeUserPrompt, renderCatalogDoc } from "./prompt.js";

/** The default maxQuestionChars, applied when NormalizeNlArgs.maxQuestionChars is omitted. */
export const DEFAULT_MAX_QUESTION_CHARS = 2000;

/**
 * Thrown when normalization cannot produce a canonical Intent: the catalog is empty, the model's answer
 * fits no Intent and no fallbackIntent was configured, the configured fallbackIntent is itself not usable,
 * or the question exceeds maxQuestionChars.
 */
export class SemanticNormalizeError extends Error {
  readonly code = "NO_MATCH" as const;
  readonly text: string;
  constructor(text: string, message = "the question does not match any intent in the catalog") {
    super(message);
    this.name = "SemanticNormalizeError";
    this.text = text;
  }
}

export interface NormalizeNlArgs {
  input: NLQuery;
  catalog: IntentCatalogLike;
  llm: LlmPort;
  rules: readonly string[];
  locale: string;
  fallbackIntent?: string;
  /** Rejects a question longer than this many characters before any LLM call. Default: DEFAULT_MAX_QUESTION_CHARS (2000). */
  maxQuestionChars?: number;
}

/**
 * Natural-language normalization (LLM, structured output). The fallback Intent is used only when the model
 * "responded normally but it does not fit a known Intent" (INVALID_OUTPUT, or a chosen Intent whose params fail
 * validation). Provider failures, cancellation and misconfiguration are thrown up to the caller (composer maps
 * them to SEMANTIC_FAILED → COMPOSE_FAILED) rather than retried through a second generation.
 */
export async function normalizeNlQuery(
  args: NormalizeNlArgs,
): Promise<{ canonical: string; params: JsonObject; fallback: boolean }> {
  const { input, catalog, llm, rules, locale, fallbackIntent } = args;
  const maxQuestionChars = args.maxQuestionChars ?? DEFAULT_MAX_QUESTION_CHARS;
  if (input.text.length > maxQuestionChars) {
    throw new SemanticNormalizeError(
      input.text,
      `the question is too long (max ${maxQuestionChars} characters)`,
    );
  }
  const names = catalog.names();
  if (names.length === 0) throw new SemanticNormalizeError(input.text);
  const outputSchema = z.object({
    intent: z.enum(names as [string, ...string[]]),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  });

  try {
    const result = await llm.generateObject({
      schema: outputSchema,
      schemaName: "canonical_intent",
      system: buildNormalizeSystemPrompt(rules),
      prompt: buildNormalizeUserPrompt(renderCatalogDoc(catalog), locale, input.text),
      temperature: 0,
    });
    const params = catalog.normalizeParams(result.object.intent, result.object.params as JsonObject);
    if (params != null) return { canonical: result.object.intent, params, fallback: false };
  } catch (e) {
    if (!(e instanceof LlmError) || e.code !== "INVALID_OUTPUT") throw e;
  }
  if (fallbackIntent == null) throw new SemanticNormalizeError(input.text);
  if (catalog.get(fallbackIntent) == null) {
    throw new SemanticNormalizeError(
      input.text,
      `the fallback intent "${fallbackIntent}" is not in the catalog`,
    );
  }
  const fallbackParams = catalog.normalizeParams(fallbackIntent, { request: input.text });
  if (fallbackParams == null) {
    throw new SemanticNormalizeError(
      input.text,
      `the fallback intent "${fallbackIntent}" rejected the fallback params { request }`,
    );
  }
  return { canonical: fallbackIntent, params: fallbackParams, fallback: true };
}

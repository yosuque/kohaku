import { LlmError, type LlmPort } from "@kohaku-ui/llm";
import type { JsonObject, NLQuery, SessionContext } from "@kohaku-ui/spec-core";
import { z } from "zod";
import type { IntentCatalogLike } from "./catalog.js";
import { buildNormalizeSystemPrompt, buildNormalizeUserPrompt, renderCatalogDoc } from "./prompt.js";

/** Thrown when the model's answer fits no Intent and no fallbackIntent was configured. */
export class SemanticNormalizeError extends Error {
  readonly code = "NO_MATCH" as const;
  readonly text: string;
  constructor(text: string) {
    super("The question does not match any Intent in the catalog");
    this.name = "SemanticNormalizeError";
    this.text = text;
  }
}

export interface NormalizeNlArgs {
  input: NLQuery;
  ctx: SessionContext;
  catalog: IntentCatalogLike;
  llm: LlmPort;
  rules: readonly string[];
  locale: string;
  fallbackIntent?: string;
}

/**
 * Natural-language normalization (LLM, structured output). The fallback Intent is used only when the model
 * "responded normally but it does not fit a known Intent" (INVALID_OUTPUT, or a chosen Intent whose params fail
 * validation). Provider failures, cancellation and misconfiguration are thrown up to the caller (composer maps
 * them to SEMANTIC_FAILED → COMPOSE_FAILED) rather than retried through a second generation.
 */
export async function normalizeNlQuery(
  args: NormalizeNlArgs,
): Promise<{ canonical: string; params: JsonObject }> {
  const { input, catalog, llm, rules, locale, fallbackIntent } = args;
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
    if (params != null) return { canonical: result.object.intent, params };
  } catch (e) {
    if (!(e instanceof LlmError) || e.code !== "INVALID_OUTPUT") throw e;
  }
  if (fallbackIntent == null) throw new SemanticNormalizeError(input.text);
  const fallback = catalog.normalizeParams(fallbackIntent, { request: input.text });
  return { canonical: fallbackIntent, params: fallback ?? { request: input.text } };
}

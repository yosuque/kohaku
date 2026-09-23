import { z } from "zod";
import type { IntentCatalogLike } from "./catalog.js";

const catalogDocCache = new WeakMap<IntentCatalogLike, string>();

/**
 * Memoized rendering of the Intent catalog's prompt section (the `### name` blocks with each Intent's JSON Schema
 * and examples), keyed by the catalog object. A per-tenant resolver that returns the same object until a promotion
 * invalidates it never serves stale content while skipping the per-Intent z.toJSONSchema on every NL call.
 */
export function renderCatalogDoc(catalog: IntentCatalogLike): string {
  const cached = catalogDocCache.get(catalog);
  if (cached != null) return cached;
  const computed = catalog
    .list()
    .map((def) => {
      const schema = z.toJSONSchema(def.params, { target: "draft-2020-12", reused: "inline" });
      return `### ${def.name}\n${def.description}\nparams schema: ${JSON.stringify(schema)}\nExamples: ${def.examples.join(" / ")}`;
    })
    .join("\n\n");
  catalogDocCache.set(catalog, computed);
  return computed;
}

/** The normalizer's system prompt: two fixed opening lines, the product's rules, one fixed closing rule. */
export function buildNormalizeSystemPrompt(rules: readonly string[]): string {
  return [
    "You are the Intent normalizer for a business app. Map the user's question to exactly one Intent in the catalog below and",
    "extract its params. Rules:",
    ...rules,
    "- Include only the keys present in the schema in params",
  ].join("\n");
}

export function buildNormalizeUserPrompt(catalogDoc: string, locale: string, text: string): string {
  return `## Intent catalog\n\n${catalogDoc}\n\n## User question (${locale})\n${text}`;
}

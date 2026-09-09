import { formatQueryRef } from "@kohaku-ui/data-binding";
import { compileQueryTemplate } from "@kohaku-ui/intents";
import type { ComponentDraft } from "@kohaku-ui/lineage";
import { type ComponentDefinition, defineComponent, propsSchemaFromJsonSchema } from "@kohaku-ui/registry";
import { z } from "zod";
import type { IntentDef } from "./catalog.js";
import { fiscalYear, region } from "./vocab.js";

/**
 * The artifact of promotion (L2->L1 publish) (an element of the projection held by the per-tenant PromotedRegistry).
 * - Component: registered in the catalog as a sandbox-template implementation (promotion = coming under governance;
 *   replacement with a native implementation is a human development task, and the Web side renders natively once the
 *   implementation is registered)
 * - Intent: joins the natural-language-normalization vocabulary (merged into the LLM prompt catalog)
 * - Persistence: the promotion-state snapshot (promotions.json) is the sole state authority, and this projection
 *   is rebuilt by startup reconcile from the published snapshot + component.generated (html).
 *   Therefore no independent persistence to promoted.json is done (the snapshot is authoritative).
 */
export interface PromotedEntry {
  artifactId: string;
  draft: ComponentDraft;
  html: string;
  request?: string;
  publishedAt: string;
}

export function promotedComponent(entry: PromotedEntry): ComponentDefinition {
  // If draft.paramsJsonSchema exists, reconstruct propsSchema from it. As a total conversion it does not
  // throw at startup. defineComponent requires propsSchema to be a ZodObject, but propsSchemaFromJsonSchema may
  // return a z.record for a non-object schema. At runtime, safeParse / toJSONSchema work with either (the
  // sandbox-template does not use ZodObject-specific operations of L1 generation), so we treat it as a ZodObject
  // only at the boundary.
  const propsSchema = (
    entry.draft.paramsJsonSchema != null
      ? propsSchemaFromJsonSchema(entry.draft.paramsJsonSchema)
      : z.object({ title: z.string().optional() })
  ) as z.ZodObject;
  return defineComponent({
    type: entry.draft.componentType,
    version: entry.draft.version,
    description: entry.draft.description,
    propsSchema,
    capabilities: { events: [], data: "required", children: "none" },
    implementation: { kind: "sandbox-template", html: entry.html },
    fallback: {
      type: "presentMarkdown",
      mapProps: () => ({ markdown: `(${entry.draft.componentType} is not available on this surface)` }),
    },
  });
}

/**
 * Default Intent params for old promoted.json compatibility (no paramsJsonSchema / queryTemplate).
 * The value ranges for fiscalYear / region reference the same source as catalog (vocab.ts) (eliminating the duplicate definition).
 */
const DEFAULT_PROMOTED_PARAMS = z.object({
  fiscalYear: fiscalYear.default(2026),
  region: region.enum().optional(),
});

export function promotedIntent(entry: PromotedEntry): IntentDef {
  const { draft } = entry;
  // GUI facet input arrives as strings, so number/boolean are received via the coerce variant (paired with the
  // propsSchema validation, intent params use input-tolerant coercion). If paramsJsonSchema is not an object,
  // fall back to the default params (fiscalYear/region).
  const params = coercedParamsSchema(draft.paramsJsonSchema) ?? DEFAULT_PROMOTED_PARAMS;
  const template = draft.queryTemplate;
  return {
    name: draft.intentName,
    description: draft.description,
    params,
    examples: [entry.request ?? draft.description],
    toQueries: (p) => {
      if (template != null) {
        // Map intent params -> query params along the queryTemplate.
        // Unified on the same @kohaku-ui/intents helper as core Intents (a single implementation of canonicalization and missing-value exclusion).
        return [compileQueryTemplate("sales", template, p)];
      }
      // Old promoted.json compatibility: fixed trend logic.
      return [
        {
          uri: formatQueryRef({
            source: "sales",
            path: "trend",
            params: {
              fy: String(p["fiscalYear"] as number),
              ...(p["region"] != null ? { region: String(p["region"]) } : {}),
              metric: "revenue",
              granularity: "month",
            },
          }),
        },
      ];
    },
  };
}

/**
 * Builds a coerce schema for intent params from paramsJsonSchema (object).
 * Similar to propsSchemaFromJsonSchema, but to allow GUI-originated string input it uses z.coerce.number for
 * number/integer and z.coerce.boolean for boolean (query params are assumed to be flat primitives only).
 * Returns null for non-object / missing (the caller falls back to the default params).
 */
function coercedParamsSchema(schema: unknown): z.ZodObject | null {
  if (
    schema == null ||
    typeof schema !== "object" ||
    Array.isArray(schema) ||
    (schema as Record<string, unknown>)["type"] !== "object"
  ) {
    return null;
  }
  const properties = (schema as Record<string, unknown>)["properties"];
  if (properties == null || typeof properties !== "object") return null;
  const requiredList = Array.isArray((schema as Record<string, unknown>)["required"])
    ? ((schema as Record<string, unknown>)["required"] as unknown[])
    : [];
  const required = new Set(requiredList.filter((k): k is string => typeof k === "string"));
  const shape: Record<string, z.ZodType> = {};
  for (const [key, node] of Object.entries(properties as Record<string, unknown>)) {
    const base = coerceBase(node);
    const n = node as Record<string, unknown>;
    if (n != null && typeof n === "object" && "default" in n) {
      shape[key] = base.default(n["default"] as never);
    } else {
      shape[key] = required.has(key) ? base : base.optional();
    }
  }
  return z.object(shape);
}

/** Receives flat primitives via the coerce variant (unsupported types become z.unknown). */
function coerceBase(node: unknown): z.ZodType {
  if (node == null || typeof node !== "object") return z.unknown();
  const n = node as Record<string, unknown>;
  switch (n["type"]) {
    case "string": {
      const en = n["enum"];
      if (Array.isArray(en) && en.length > 0 && en.every((x) => typeof x === "string")) {
        return z.enum(en as [string, ...string[]]);
      }
      return z.string();
    }
    case "number":
      return z.coerce.number();
    case "integer":
      return z.coerce.number().int();
    case "boolean":
      // Allow GUI-originated string input. Because z.coerce.boolean has Boolean(input) semantics,
      // "false"/"0" would turn into true as non-empty strings. Receive via an explicit mapping:
      // "false"/"0"/false -> false, "true"/"1"/true -> true, everything else is rejected by z.boolean() validation.
      return z.preprocess((v) => {
        if (v === "true" || v === "1" || v === true) return true;
        if (v === "false" || v === "0" || v === false) return false;
        return v;
      }, z.boolean());
    default:
      return z.unknown();
  }
}

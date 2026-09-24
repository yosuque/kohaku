import { parseQueryRef, type QueryRef } from "@kohaku-ui/data-binding";
import type { LlmPort } from "@kohaku-ui/llm";
import type {
  CanonicalIntent,
  DataShape,
  IntentInput,
  QueryHandle,
  SemanticInput,
  SemanticPort,
  SessionContext,
} from "@kohaku-ui/spec-core";
import type { IntentCatalogLike } from "./catalog.js";
import { normalizeGuiAction } from "./gui.js";
import { normalizeNlQuery } from "./nl.js";

export interface LlmSemanticPortOptions {
  llm: LlmPort;
  /** One catalog, or a per-tenant resolver (promotion adds Intents per tenant). */
  catalog: IntentCatalogLike | ((tenant?: string) => IntentCatalogLike);
  dataVersion: (handle: QueryHandle) => Promise<string> | string;
  /** Column metadata for a parsed query ref (no rows). Return null for an unknown path (→ throws). Omit to leave SemanticPort.describeShape undefined. */
  describeShape?: (ref: QueryRef) => DataShape | null;
  /** Extra system-prompt rules (product-specific), rendered as "- …" lines after the generic ones. */
  rules?: (ctx: SessionContext) => string[];
  /** Intent to fall back to (params { request: text }) when the model's answer fits no Intent. Without it, normalize throws SemanticNormalizeError. */
  fallbackIntent?: string;
  /** Maps a locale tag to the "(locale)" label in the prompt. Default: the tag itself, "en" when absent. */
  outputLocale?: (locale?: string) => string;
}

/**
 * The default SemanticPort: GUI operations are deterministic, natural language is mapped onto the Intent catalog by
 * the LLM, and both converge on the same CanonicalIntent. Intent definitions come from @kohaku-ui/intents; queries are
 * resolved from them (reference passing — no rows ever enter the model's context).
 *
 * This is a starting point (adoption-ladder Step 1). The Intent layer remains a product responsibility: replace it
 * with your own SemanticPort when the catalog, prompt or fallback policy outgrow these options.
 */
export function createLlmSemanticPort(options: LlmSemanticPortOptions): SemanticPort {
  const { llm, dataVersion, describeShape, rules, fallbackIntent } = options;
  const catalogFor =
    typeof options.catalog === "function" ? options.catalog : () => options.catalog as IntentCatalogLike;
  const outputLocale = options.outputLocale ?? ((locale?: string) => locale ?? "en");

  const port: SemanticPort = {
    async normalize(input: SemanticInput, ctx: SessionContext): Promise<IntentInput> {
      const catalog = catalogFor(ctx.tenant);
      if (input.kind === "gui") return normalizeGuiAction(input, catalog);
      return normalizeNlQuery({
        input,
        ctx,
        catalog,
        llm,
        rules: rules?.(ctx) ?? [],
        locale: outputLocale(input.locale ?? ctx.locale),
        ...(fallbackIntent != null ? { fallbackIntent } : {}),
      });
    },
    async resolveQuery(intent: CanonicalIntent, ctx?: { tenant?: string }): Promise<QueryHandle[]> {
      const def = catalogFor(ctx?.tenant).get(intent.canonical);
      if (def == null) throw new Error(`unknown intent: ${intent.canonical}`);
      return def.toQueries(intent.params);
    },
    async dataVersion(handle: QueryHandle): Promise<string> {
      return dataVersion(handle);
    },
  };
  if (describeShape != null) {
    port.describeShape = async (handle: QueryHandle): Promise<DataShape> => {
      const ref = parseQueryRef(handle.uri);
      const shape = describeShape(ref);
      if (shape == null) throw new Error(`unknown query path: ${ref.path}`);
      return shape;
    };
  }
  return port;
}

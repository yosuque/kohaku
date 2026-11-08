import { parseQueryRef, type QueryRef } from "@kohaku-ui/data-binding";
import type { LlmPort } from "@kohaku-ui/llm";
import {
  type CanonicalIntent,
  type DataShape,
  type FilterDescriptor,
  type IntentInput,
  IntentValidationError,
  type QueryHandle,
  type SemanticInput,
  type SemanticPort,
  type SessionContext,
} from "@kohaku-ui/spec-core";
import type { IntentCatalogLike } from "./catalog.js";
import { DEFAULT_MAX_FILTER_VARIANTS, paramsCheckFor, vetFilters } from "./filters.js";
import { normalizeGuiAction } from "./gui.js";
import { normalizeNlQuery } from "./nl.js";

/**
 * Thrown by resolveQuery when the intent's canonical name is not present in the (possibly per-tenant)
 * catalog. Carries a string `code` property (the general convention for a "typed" internal error) and,
 * separately, `clientSafe: true` — the narrower, explicit opt-in composer's SEMANTIC_FAILED wrapping
 * (packages/composer/src/refs.ts's `isClientSafeCause`) requires before it will surface a cause's own
 * message to the client. This message is safe to opt in: it names no internals, only the (already
 * client-supplied) intent name.
 */
export class UnknownIntentError extends Error {
  readonly code = "UNKNOWN_INTENT" as const;
  /** Opts in to composer's SEMANTIC_FAILED message enrichment — see isClientSafeCause's doc. */
  readonly clientSafe = true as const;
  readonly canonical: string;
  constructor(canonical: string) {
    super(`unknown intent "${canonical}"`);
    this.name = "UnknownIntentError";
    this.canonical = canonical;
  }
}

/** A BCP-47-like language tag: ASCII letters, digits and hyphens, at most 35 characters (RFC 5646's longest practical tag). */
const LOCALE_TAG = /^[A-Za-z0-9-]{1,35}$/;

/**
 * The default `outputLocale`: the "(locale)" label in the normalizer's user prompt. The tag comes from the client
 * (`NLQuery.locale`) and is interpolated outside the USER_QUESTION delimiter block, so anything that is not a
 * BCP-47-like tag (letters, digits, hyphens; at most 35 characters) is replaced by `"und"` (undetermined) instead
 * of reaching the prompt verbatim. An absent tag is `"en"`. A custom `outputLocale` replaces this entirely and
 * owns its own sanitization.
 */
export function defaultOutputLocale(locale?: string): string {
  if (locale == null) return "en";
  return LOCALE_TAG.test(locale) ? locale : "und";
}

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
  /** Maps a locale tag to the "(locale)" label in the prompt. Default: `defaultOutputLocale` (the tag itself when it is BCP-47-like, "und" otherwise, "en" when absent). */
  outputLocale?: (locale?: string) => string;
  /** Rejects an NL question longer than this many characters before any LLM call. Default: 2000. */
  maxQuestionChars?: number;
  /**
   * The budget of `describeFilters`' product check: the number of filter-option combinations validated against
   * the Intent's params schema (a combination its `refine` forbids makes the Intent expose NO filters). More
   * combinations than this are not provable and also yield no filters. Default: 64, the composer's default
   * `l1FiltersMaxVariants` -- raise both together.
   */
  maxFilterVariants?: number;
  /**
   * Observation hook, called after every successful NL normalization (both the matched-Intent and the
   * fallback outcomes; never called before a throw). Fail-open: a throwing hook is caught and ignored, so an
   * observability bug can never break normalization.
   */
  onNormalized?: (info: { text: string; canonical: string; fallback: boolean; tenant?: string }) => void;
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
  const { llm, dataVersion, describeShape, rules, fallbackIntent, maxQuestionChars, onNormalized } = options;
  const maxFilterVariants = options.maxFilterVariants ?? DEFAULT_MAX_FILTER_VARIANTS;
  const catalogFor =
    typeof options.catalog === "function" ? options.catalog : () => options.catalog as IntentCatalogLike;
  const outputLocale = options.outputLocale ?? defaultOutputLocale;

  const port: SemanticPort = {
    async normalize(input: SemanticInput, ctx: SessionContext): Promise<IntentInput> {
      const catalog = catalogFor(ctx.tenant);
      if (input.kind === "gui") return normalizeGuiAction(input, catalog);
      const result = await normalizeNlQuery({
        input,
        catalog,
        llm,
        rules: rules?.(ctx) ?? [],
        locale: outputLocale(input.locale ?? ctx.locale),
        ...(fallbackIntent != null ? { fallbackIntent } : {}),
        ...(maxQuestionChars != null ? { maxQuestionChars } : {}),
      });
      if (onNormalized != null) {
        try {
          onNormalized({
            text: input.text,
            canonical: result.canonical,
            fallback: result.fallback,
            ...(ctx.tenant != null ? { tenant: ctx.tenant } : {}),
          });
        } catch {
          // Fail-open: an observation hook must never break normalization.
        }
      }
      return { canonical: result.canonical, params: result.params };
    },
    async resolveQuery(intent: CanonicalIntent, ctx?: { tenant?: string }): Promise<QueryHandle[]> {
      const def = catalogFor(ctx?.tenant).get(intent.canonical);
      if (def == null) throw new UnknownIntentError(intent.canonical);
      return def.toQueries(intent.params);
    },
    async dataVersion(handle: QueryHandle): Promise<string> {
      return dataVersion(handle);
    },
    async describeFilters(
      intent: CanonicalIntent,
      ctx?: { tenant?: string; locale?: string },
    ): Promise<FilterDescriptor[]> {
      // An unknown Intent has no filters (resolveQuery is what reports it); an Intent defined without facets
      // or on the callback path has no `filters` derivation, which is the same "no filters" answer.
      const catalog = catalogFor(ctx?.tenant);
      const def = catalog.get(intent.canonical);
      const filters = def?.filters?.(ctx?.locale);
      if (def == null || filters == null || filters.length === 0) return [];
      // The Intent's params validation (the catalog's own validator, the one compose enforces) is the
      // authority: options it rejects are dropped, and a product containing a forbidden combination yields no
      // filters at all (the composer signs the whole product of the filters it injects).
      return vetFilters(def, intent, filters, maxFilterVariants, paramsCheckFor(catalog, def));
    },
    async validateIntent(intent: IntentInput, ctx: SessionContext): Promise<IntentInput> {
      const catalog = catalogFor(ctx.tenant);
      if (catalog.validateParams != null) {
        const result = catalog.validateParams(intent.canonical, intent.params);
        if (result.ok) return { canonical: intent.canonical, params: result.params };
        throw new IntentValidationError(
          result.issues.map((issue) => issue.message).join("; "),
          result.issues,
        );
      }
      // The catalog does not implement validateParams: fall back to the looser (name-known?, normalizeParams)
      // checks, which cannot detect an unknown param key or report per-key issues.
      if (catalog.get(intent.canonical) == null) {
        throw new IntentValidationError(`unknown intent "${intent.canonical}"`);
      }
      const params = catalog.normalizeParams(intent.canonical, intent.params);
      if (params == null) {
        throw new IntentValidationError(`invalid params for intent "${intent.canonical}"`);
      }
      return { canonical: intent.canonical, params };
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

import { parseQueryRef } from "@kohaku-ui/data-binding";
import { LlmError, type LlmPort } from "@kohaku-ui/llm";
import type {
  CanonicalIntent,
  DataShape,
  IntentInput,
  JsonObject,
  QueryHandle,
  SemanticInput,
  SemanticPort,
  SessionContext,
} from "@kohaku-ui/spec-core";
import { z } from "zod";
import { languageOf } from "../app/compose-context.js";
import { shapeOf } from "../domain/queries.js";
import type { SalesRepo } from "../domain/repo.js";
import { fiscalYearOf, quarterOf } from "../domain/types.js";
import type { IntentCatalog } from "../intents/catalog.js";
import { FISCAL_YEAR_MAX, FISCAL_YEAR_MIN } from "../intents/vocab.js";

const catalogDocCache = new WeakMap<IntentCatalog, string>();

/**
 * Memoized rendering of the Intent catalog's prompt section (the `### name` blocks with each Intent's
 * JSON Schema and examples), keyed by the IntentCatalog object. PromotedRegistry.intentCatalogFor
 * returns the same object for the same tenant until a promotion invalidates it (a fresh object is built
 * then), so this cache never serves stale content while still skipping the per-Intent
 * `z.toJSONSchema` + string-building work on every NL-normalize LLM call.
 */
function cachedCatalogDoc(catalog: IntentCatalog): string {
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

/**
 * SemanticPort implementation — the core of R5.
 * GUI operations are deterministic without going through the LLM, natural language is mapped to the Intent catalog
 * by the LLM, and both converge on the same CanonicalIntent.
 */
export function createSemanticPort(args: {
  repo: SalesRepo;
  /**
   * Resolution of the per-tenant Intent catalog. Since Intents added by promotion (publish) are independent per
   * tenant, returns base (core Intents) + the given tenant's promoted Intents. normalize looks up by session.tenant,
   * resolveQuery by ctx.tenant. With no tenant specified (single tenant), base + the default tenant's promotions.
   */
  catalogFor: (tenant?: string) => IntentCatalog;
  llm: LlmPort;
  /**
   * A source of the current time (used to resolve "current period" / "current quarter" in the NL normalization prompt).
   * Defaults to real time. Tests inject a fixed date/time to make it deterministic.
   */
  now?: () => Date;
}): SemanticPort {
  const { repo, catalogFor, llm, now = () => new Date() } = args;

  return {
    async normalize(input: SemanticInput, ctx: SessionContext): Promise<IntentInput> {
      // Does not compute hash. The deterministic hash is filled in by the caller's (composer / host) finalizeIntent.
      // Look up the tenant's Intent catalog (vocabulary separation of promoted Intents).
      const catalog = catalogFor(ctx.tenant);
      return input.kind === "gui"
        ? normalizeGui(input, catalog)
        : await normalizeNl(input, catalog, llm, ctx, now);
    },

    async resolveQuery(intent: CanonicalIntent, ctx?: { tenant?: string }): Promise<QueryHandle[]> {
      // resolveQuery also looks up by the tenant's Intent catalog (promoted Intents are per-tenant).
      const def = catalogFor(ctx?.tenant).get(intent.canonical);
      if (def == null) throw new Error(`unknown intent: ${intent.canonical}`);
      return def.toQueries(intent.params);
    },

    async dataVersion(): Promise<string> {
      // Common to all queries since it is a single domain (the granularity choice is Open Question #4)
      return repo.dataVersion();
    },

    async describeShape(handle: QueryHandle): Promise<DataShape> {
      const ref = parseQueryRef(handle.uri);
      const shape = shapeOf(ref.path, ref.params);
      if (shape == null) throw new Error(`unknown query path: ${ref.path}`);
      return shape;
    },
  };
}

/** Deterministic normalization of GUI operations (does not pass through the LLM) */
function normalizeGui(
  input: Extract<SemanticInput, { kind: "gui" }>,
  catalog: IntentCatalog,
): { canonical: string; params: JsonObject } {
  // 1. View selection / facet change: specify the view via params.intent, merged with current
  if (input.action === "view.select" || input.action === "facet.change") {
    const requested = (input.params["intent"] as string | undefined) ?? input.current?.canonical;
    if (requested == null) throw new Error("view.select requires params.intent");
    const def = catalog.get(requested);
    if (def == null) throw new Error(`unknown intent: ${requested}`);
    const { intent: _drop, ...facets } = input.params;
    const base = input.current?.canonical === requested ? input.current.params : {};
    const params = catalog.normalizeParams(requested, { ...base, ...facets } as JsonObject);
    if (params == null) throw new Error(`invalid params for ${requested}`);
    return { canonical: requested, params };
  }

  // 2. Component events ("table1.rowClick", etc.): delegate to the Intent definition's drilldown
  if (input.action.includes(".") && input.current != null) {
    const def = catalog.get(input.current.canonical);
    if (def?.drilldown != null) {
      const next = def.drilldown(input.current.params, input.params);
      const canonical = next.canonical ?? input.current.canonical;
      const params = catalog.normalizeParams(canonical, next.params);
      if (params == null) throw new Error(`drilldown produced invalid params for ${canonical}`);
      return { canonical, params };
    }
    // drilldown undefined: reflect only what can be merged from payload into params
    const params = catalog.normalizeParams(input.current.canonical, {
      ...input.current.params,
      ...input.params,
    } as JsonObject);
    if (params == null) throw new Error("event payload produced invalid params");
    return { canonical: input.current.canonical, params };
  }

  throw new Error(`unsupported gui action: ${input.action}`);
}

/**
 * Runtime computation of the fiscal period (starts in April), delegating the FY-label and quarter conventions
 * to domain/types.ts's fiscalYearOf/quarterOf (the single source, also used by scripts/generate-seed.ts) so this
 * real-clock reading and the seed's own fiscal calendar cannot drift apart.
 * Used to derive the NL normalization prompt's "current period", "current quarter", and "prior year" from the current
 * time rather than fixed strings.
 *
 * Timezone note: `getFullYear`/`getMonth` read the calendar date in the server process's local timezone (not UTC).
 * Around the April 1 fiscal-year boundary (and, less critically, the other quarter boundaries), a request made in
 * the last hours of March 31 or the first hours of April 1 local time can therefore land on either side of the
 * boundary depending on which timezone the server process runs in, even though the underlying instant is the
 * same. This only affects the NL-normalization prompt's "this period"/"this quarter" hint (not the seed data or
 * any stored value), and the demo seed's fixed FY2025-FY2026 range is unaffected either way.
 */
export function fiscalPeriodOf(date: Date): {
  fiscalYear: number;
  quarter: 1 | 2 | 3 | 4;
  /** Calendar year and month (for the prompt's "current year YYYY, month M" wording; distinct from the fiscal year). */
  year: number;
  month: number;
} {
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // 1-12
  return { fiscalYear: fiscalYearOf(year, month), quarter: quarterOf(month), year, month };
}

/**
 * Clamps the fiscal year to vocab's value range (FISCAL_YEAR_MIN to FISCAL_YEAR_MAX).
 * Since fiscalPeriodOf derives the fiscal year from real time, it can return a year beyond the range the seed holds
 * (FY2025 to FY2026) (e.g., FY2027 from April 2027 onward). The seed is fixed-generated time-independently
 * (scripts/generate-seed.ts), so out-of-range years do not exist. We round here before injecting into the NL
 * normalization prompt, so the LLM is not made to choose a nonexistent year (outside the fiscalYear enum).
 * fiscalPeriodOf itself, as pure fiscal-period computation, returns out-of-range values as-is (rounding is a normalization concern, so it is confined here).
 */
function clampFiscalYear(fiscalYear: number): number {
  return Math.min(FISCAL_YEAR_MAX, Math.max(FISCAL_YEAR_MIN, fiscalYear));
}

/**
 * Natural-language normalization (LLM).
 * Falls back to sales.custom (L2 free generation) only when "the LLM responded normally but it does not fit a known Intent".
 * Provider failures, cancellation, and misconfiguration are not degraded but thrown up to the caller (see the catch below).
 */
async function normalizeNl(
  input: Extract<SemanticInput, { kind: "nl" }>,
  catalog: IntentCatalog,
  llm: LlmPort,
  ctx: SessionContext,
  now: () => Date,
): Promise<{ canonical: string; params: JsonObject }> {
  const text = input.text;
  // Locale hint precedence: the per-input NLQuery.locale wins over the session's, then the composer's own
  // output-language default (English; see languageOf), rather than a second "ja" literal here. languageOf also
  // normalizes any locale tag to its "ja"/"en" prompt hint (e.g. "ja-JP" -> "ja"), so the hint stays consistent
  // with how the rest of the app resolves output language for the same session.
  const locale = languageOf(input.locale ?? ctx.locale);
  const names = catalog.names();
  const outputSchema = z.object({
    intent: z.enum(names as [string, ...string[]]),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  });

  const catalogDoc = cachedCatalogDoc(catalog);

  // "current period", "current quarter", and "prior year" are computed at runtime from the current time (an injectable
  // clock) rather than fixed strings (a fixed value would make the prompt stale over time and induce wrong answers once a quarter is crossed).
  const period = fiscalPeriodOf(now());
  // Even if real time exceeds the seed range (FY2025 to FY2026), clamp to vocab's value range so a nonexistent year is
  // not chosen (e.g., FY2027 at the year 2027 -> FY2026). The prior year is the clamped current fiscal year minus 1,
  // clamped again to also prevent falling below the lower bound (FY2024, etc.). The quarter and the calendar year/month
  // (the "current year YYYY, month M" display) are informational, so they are not rounded (quarter is always within 1-4).
  const currentFiscalYear = clampFiscalYear(period.fiscalYear);
  const prevFiscalYear = clampFiscalYear(currentFiscalYear - 1);

  try {
    const result = await llm.generateObject({
      schema: outputSchema,
      schemaName: "canonical_intent",
      system: [
        "You are the Intent normalizer for a business app. Map the user's question to exactly one Intent in the catalog below and",
        "extract its params. Rules:",
        `- The fiscal year starts in April (FY${currentFiscalYear} = ${currentFiscalYear}-04 to ${currentFiscalYear + 1}-03). "this period"/"this fiscal year" (今期/今年度) = fiscalYear=${currentFiscalYear}; "this quarter" (今四半期) = quarter=${period.quarter} (now ${period.year}-${period.month}).`,
        `- "last year"/"prior fiscal year" (前年/昨年度) = fiscalYear=${prevFiscalYear}`,
        "- Normalize region names to japan / north_america / europe / apac (日本→japan, 北米→north_america, 欧州/ヨーロッパ→europe, アジア太平洋→apac)",
        "- For a visualization request that fits no Intent (a heatmap, matrix, or other bespoke form), choose sales.custom and put the original request text verbatim into params.request",
        "- Include only the keys present in the schema in params",
      ].join("\n"),
      prompt: `## Intent catalog\n\n${catalogDoc}\n\n## User question (${locale})\n${text}`,
      temperature: 0,
    });

    const params = catalog.normalizeParams(result.object.intent, result.object.params as JsonObject);
    if (params != null) return { canonical: result.object.intent, params };
    // Normal response but inconsistent with a known Intent (the enum was chosen but params validation failed) -> the custom fallback below.
  } catch (e) {
    // The fallback to custom is limited to "responded normally but does not fit the intent".
    // Only INVALID_OUTPUT (there was a response but it does not conform to the schema) qualifies, and falls through to custom.
    // ABORTED (cancellation) / PROVIDER (provider failure) / CONFIG (misconfiguration) are not even normal responses.
    // Falling back to custom here would make L2 throw a full generation again at the same broken/aborted provider and
    // fail twice, so instead of swallowing it we throw it up to the caller (composer) to surface it as SEMANTIC_FAILED -> COMPOSE_FAILED.
    // Non-LlmError (= an unexpected bug) is thrown likewise.
    if (!(e instanceof LlmError) || e.code !== "INVALID_OUTPUT") throw e;
  }
  const fallback = catalog.normalizeParams("sales.custom", { request: text });
  return { canonical: "sales.custom", params: fallback ?? { request: text } };
}

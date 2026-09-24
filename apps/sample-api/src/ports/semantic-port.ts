import type { LlmPort } from "@kohaku-ui/llm";
import { createLlmSemanticPort } from "@kohaku-ui/semantic-llm";
import type { SemanticPort } from "@kohaku-ui/spec-core";
import { languageOf } from "../app/compose-context.js";
import { shapeOf } from "../domain/queries.js";
import type { SalesRepo } from "../domain/repo.js";
import { fiscalYearOf, quarterOf } from "../domain/types.js";
import type { IntentCatalog } from "../intents/catalog.js";
import { FISCAL_YEAR_MAX, FISCAL_YEAR_MIN } from "../intents/vocab.js";

/**
 * SemanticPort implementation — the core of R5, now built on @kohaku-ui/semantic-llm's default port.
 * What stays product-specific here: the sales rules of the normalization prompt (fiscal calendar from an injectable
 * clock, region name normalization, the sales.custom escape hatch), the shape lookup and the data version.
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
  return createLlmSemanticPort({
    llm,
    catalog: catalogFor,
    dataVersion: () => repo.dataVersion(),
    describeShape: (ref) => shapeOf(ref.path, ref.params),
    rules: () => salesRules(now()),
    fallbackIntent: "sales.custom",
    outputLocale: languageOf,
  });
}

/** The sales-domain lines of the normalization prompt (unchanged wording; see the historical semantic-port.ts). */
function salesRules(date: Date): string[] {
  const period = fiscalPeriodOf(date);
  const currentFiscalYear = clampFiscalYear(period.fiscalYear);
  const prevFiscalYear = clampFiscalYear(currentFiscalYear - 1);
  return [
    `- The fiscal year starts in April (FY${currentFiscalYear} = ${currentFiscalYear}-04 to ${currentFiscalYear + 1}-03). "this period"/"this fiscal year" (今期/今年度) = fiscalYear=${currentFiscalYear}; "this quarter" (今四半期) = quarter=${period.quarter} (now ${period.year}-${period.month}).`,
    `- "last year"/"prior fiscal year" (前年/昨年度) = fiscalYear=${prevFiscalYear}`,
    "- Normalize region names to japan / north_america / europe / apac (日本→japan, 北米→north_america, 欧州/ヨーロッパ→europe, アジア太平洋→apac)",
    "- For a visualization request that fits no Intent (a heatmap, matrix, or other bespoke form), choose sales.custom and put the original request text verbatim into params.request",
  ];
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

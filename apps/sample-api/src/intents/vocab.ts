import { defineVocabulary, type Vocabulary, type VocabularyEntry } from "@kohaku-ui/intents";
import { z } from "zod";
import { CHANNEL_LABELS, REGION_LABELS } from "../domain/types.js";

/**
 * The single source for the sales-domain vocabulary (value set + display labels). catalog / promoted / GUI facets
 * reference this instead of duplicating value-set definitions across types.ts, the catalog enum, the promoted enum, and FacetPanel.
 * For region / channel, domain/types.ts's *_LABELS are promoted to the single source (canonical English), and the
 * JA overlays declared here make this vocabulary the single source for both languages (fixed specs, facet views,
 * and drilldown reverse-lookup all draw from it).
 */

/** Merges the canonical (English) label map with a same-key JA map into bilingual entries. */
function bilingual<K extends string>(
  en: Readonly<Record<K, string>>,
  ja: Readonly<Record<K, string>>,
): Record<string, VocabularyEntry> {
  const entries: Record<string, VocabularyEntry> = {};
  for (const code of Object.keys(en) as K[]) {
    entries[code] = { en: en[code], ja: ja[code] };
  }
  return entries;
}

export const region: Vocabulary = defineVocabulary(
  "region",
  bilingual(REGION_LABELS, { japan: "日本", north_america: "北米", europe: "欧州", apac: "APAC" }),
);
export const channel: Vocabulary = defineVocabulary(
  "channel",
  bilingual(CHANNEL_LABELS, { direct: "直販", partner: "パートナー", online: "オンライン" }),
);

/** Metric (revenue / units). The enum for the GUI "metric" facet and for NL normalization. */
export const metric: Vocabulary = defineVocabulary("metric", {
  revenue: { en: "Revenue", ja: "売上" },
  units: { en: "Units", ja: "販売数" },
});

/** Aggregation axis. Matched to the facet's aggregation-axis labels (by region / by product / by channel). */
export const groupBy: Vocabulary = defineVocabulary("groupBy", {
  region: { en: "By region", ja: "地域別" },
  product: { en: "By product", ja: "製品別" },
  channel: { en: "By channel", ja: "チャネル別" },
});

/** Time-series granularity (monthly / quarterly). */
export const granularity: Vocabulary = defineVocabulary("granularity", {
  month: { en: "Monthly", ja: "月次" },
  quarter: { en: "Quarterly", ja: "四半期" },
});

/**
 * The single source for the fiscal-year value range (FY2025-FY2026). Kept consistent with the range the seed holds
 * (scripts/generate-seed.ts deterministically generates two fiscal years, time-independently). The fiscalYear Zod
 * fragment's min/max and the NL-normalization "current period" clamp (semantic-port.ts) share this constant,
 * eliminating the duplicated range definition.
 */
export const FISCAL_YEAR_MIN = 2025;
export const FISCAL_YEAR_MAX = 2026;

/**
 * Fiscal year (starts in April; FY2025-FY2026). A shared Zod fragment that coerces string input coming from the GUI.
 * catalog and promoted reference the same fragment, eliminating the duplicated range (min/max) definition.
 */
export const fiscalYear = z.coerce.number().int().min(FISCAL_YEAR_MIN).max(FISCAL_YEAR_MAX);
/** Quarter (1-4). A shared Zod fragment. */
export const quarter = z.coerce.number().int().min(1).max(4);

/**
 * The demo "current period" defaults, single-sourced here instead of scattered as literals across catalog.ts,
 * queries.ts, and (informationally) the Python mirror. Values are unchanged from before this constant existed
 * (DEMO_FISCAL_YEAR === FISCAL_YEAR_MAX), so canonical URIs, cache keys, goldens, and facet-views.json are unaffected.
 */
export const DEMO_FISCAL_YEAR = FISCAL_YEAR_MAX;
/**
 * sales.quarterly_summary and sales.target_attainment intentionally default to different quarters. Both quarters
 * have complete records and targets in the seed for every fiscal year (there is no data-completeness reason for
 * the split); the difference is a demo choice — each intent's default quarter matches the quarter used in its own
 * example questions (e.g. "FY2026 Q3 sales by region" / "What's the Q2 target attainment?") — kept as-is for
 * cache/golden stability.
 */
export const DEMO_QUARTER_SUMMARY = 3;
export const DEMO_QUARTER_ATTAINMENT = 2;

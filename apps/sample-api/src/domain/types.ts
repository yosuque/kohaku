export type Region = "japan" | "north_america" | "europe" | "apac";
export type Channel = "direct" | "partner" | "online";
export type Category = "software" | "hardware" | "services";

export const REGIONS: Region[] = ["japan", "north_america", "europe", "apac"];
export const CHANNELS: Channel[] = ["direct", "partner", "online"];

export const REGION_LABELS: Record<Region, string> = {
  japan: "Japan",
  north_america: "North America",
  europe: "Europe",
  apac: "APAC",
};

/**
 * Channel code -> display label. For display only (table/chart cell values);
 * query parameters, filters, and drilldown keys are handled as codes (direct, etc.).
 * The display labels are kept consistent with sample-web's filtering UI (FacetPanel).
 */
export const CHANNEL_LABELS: Record<Channel, string> = {
  direct: "Direct",
  partner: "Partner",
  online: "Online",
};

/**
 * Aggregation-axis code -> display label (the region/product/channel groupBy axis). The single source
 * shared by domain/queries.ts's summary column label (groupLabel) and intents/fixed-specs.ts's EN title
 * fragment (groupByPhrase), so the two no longer carry duplicated Region/Product/Channel maps.
 * Distinct from intents/vocab.ts's `groupBy` vocabulary ("By region" style facet display strings, EN+JA),
 * which serves a different UI surface — do not merge the two.
 */
export const GROUP_AXIS_LABELS: Record<"region" | "product" | "channel", string> = {
  region: "Region",
  product: "Product",
  channel: "Channel",
};

export interface Product {
  id: string;
  name: string;
  category: Category;
  unitPrice: number; // JPY
}

export interface SalesRecord {
  id: string;
  /** Fiscal year (starts in April; labeled by start year. FY2026 = 2026-04 to 2027-03) */
  fiscalYear: number;
  /** Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar */
  quarter: 1 | 2 | 3 | 4;
  /** Calendar month "2026-04" */
  month: string;
  region: Region;
  productId: string;
  channel: Channel;
  units: number;
  // Amounts assume a single currency (JPY). Currency codes, FX, and multiple currencies are not handled.
  revenue: number; // JPY
}

export interface SalesTarget {
  fiscalYear: number;
  quarter: 1 | 2 | 3 | 4;
  region: Region;
  targetRevenue: number;
}

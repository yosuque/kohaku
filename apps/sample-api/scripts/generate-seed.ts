/**
 * Deterministic seed generator. With a fixed PRNG (seed=20260610), generates and commits 2 fiscal years x 12 months x
 * 4 regions x 6 products = 576 sales records and 32 targets.
 * Since it does not depend on "today", the FY2026 Q3 demo always holds.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHANNELS,
  type Product,
  quarterOf,
  REGIONS,
  type SalesRecord,
  type SalesTarget,
} from "../src/domain/types.js";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src/domain/seed");

const PRODUCTS: Product[] = [
  { id: "prd-001", name: "Aurora Analytics", category: "software", unitPrice: 1_200_000 },
  { id: "prd-002", name: "Aurora CRM", category: "software", unitPrice: 800_000 },
  { id: "prd-003", name: "EdgeSight Sensor", category: "hardware", unitPrice: 150_000 },
  { id: "prd-004", name: "EdgeSight Gateway", category: "hardware", unitPrice: 450_000 },
  { id: "prd-005", name: "Managed Support", category: "services", unitPrice: 300_000 },
  { id: "prd-006", name: "Onboarding Pack", category: "services", unitPrice: 500_000 },
];

/** Baseline monthly units per product (when the region weight is 1.0) */
const BASE_MONTHLY_UNITS: Record<string, number> = {
  "prd-001": 32,
  "prd-002": 52,
  "prd-003": 160,
  "prd-004": 45,
  "prd-005": 80,
  "prd-006": 26,
};

const REGION_WEIGHT: Record<string, number> = {
  japan: 1.0,
  north_america: 1.3,
  europe: 0.9,
  apac: 0.7,
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260610);

/**
 * The calendar month ("YYYY-MM") and quarter of the m-th (0-11) month of the FY.
 * calYear is derived fy -> calendar (the inverse of types.ts's fiscalYearOf, which goes
 * calendar -> fy), so it is computed directly here rather than via that helper; quarter is
 * the forward direction (calMonth -> quarter), so it reuses quarterOf directly (previously a
 * duplicate `Math.floor(index / 3) + 1` formula — the seed invariant test in test/ confirms
 * every generated record's quarter equals quarterOf(its own calendar month)).
 */
function fiscalMonth(fy: number, index: number): { month: string; quarter: 1 | 2 | 3 | 4 } {
  const calMonth = ((index + 3) % 12) + 1; // 4,5,...,12,1,2,3
  const calYear = calMonth >= 4 ? fy : fy + 1;
  return {
    month: `${calYear}-${String(calMonth).padStart(2, "0")}`,
    quarter: quarterOf(calMonth),
  };
}

/** Seasonality: Q4 (Jan-Mar) gets +15% at year-end, September (index=5) gets +10% at mid-year-end */
function seasonality(index: number): number {
  if (index >= 9) return 1.15;
  if (index === 5) return 1.1;
  return 1.0;
}

const records: SalesRecord[] = [];
for (const fy of [2025, 2026]) {
  const growth = fy === 2026 ? 1.08 : 1.0;
  for (let m = 0; m < 12; m++) {
    const { month, quarter } = fiscalMonth(fy, m);
    for (const region of REGIONS) {
      for (const product of PRODUCTS) {
        const noise = 0.9 + rand() * 0.2; // +/-10%
        const units = Math.max(
          1,
          Math.round(
            BASE_MONTHLY_UNITS[product.id]! * REGION_WEIGHT[region]! * seasonality(m) * growth * noise,
          ),
        );
        const revenue = units * product.unitPrice;
        const channel = CHANNELS[(REGIONS.indexOf(region) + PRODUCTS.indexOf(product) + m) % 3]!;
        records.push({
          id: `sr-${month}-${region}-${product.id}-${channel}`,
          fiscalYear: fy,
          quarter,
          month,
          region,
          productId: product.id,
          channel,
          units,
          revenue,
        });
      }
    }
  }
}

const targets: SalesTarget[] = [];
for (const fy of [2025, 2026]) {
  for (const quarter of [1, 2, 3, 4] as const) {
    for (const region of REGIONS) {
      const actual = records
        .filter((r) => r.fiscalYear === fy && r.quarter === quarter && r.region === region)
        .reduce((sum, r) => sum + r.revenue, 0);
      // The target is a deterministic value at 92-112% of actual (so a mix of met/unmet is interesting)
      const factor = 0.92 + rand() * 0.2;
      targets.push({
        fiscalYear: fy,
        quarter,
        region,
        targetRevenue: Math.round((actual * factor) / 1_000_000) * 1_000_000,
      });
    }
  }
}

mkdirSync(OUT_DIR, { recursive: true });
// Build the JSON strings to write once, and compute the content hash from the same byte sequence.
const productsJson = JSON.stringify(PRODUCTS, null, 2) + "\n";
const recordsJson = JSON.stringify(records, null, 2) + "\n";
const targetsJson = JSON.stringify(targets, null, 2) + "\n";
writeFileSync(join(OUT_DIR, "products.json"), productsJson);
writeFileSync(join(OUT_DIR, "sales-records.json"), recordsJson);
writeFileSync(join(OUT_DIR, "sales-targets.json"), targetsJson);

// Write the content hash mechanically derived from the output to meta.json.
// Since SalesRepo includes this in dataVersion, even if you forget to update the SEED_VERSION constant, dataVersion
// (= a cache-key component) is guaranteed to change when the seed content changes, so an old Spec is not kept being served.
// meta.json is a pure function with no non-deterministic elements such as timestamps, so on regeneration, if the content
// is the same, it is byte-identical and produces no git diff (preserving determinism).
const contentHash = createHash("sha256")
  .update(productsJson)
  .update(recordsJson)
  .update(targetsJson)
  .digest("hex");
const meta = {
  contentHash: `sha256:${contentHash}`,
  products: PRODUCTS.length,
  records: records.length,
  targets: targets.length,
};
writeFileSync(join(OUT_DIR, "meta.json"), JSON.stringify(meta, null, 2) + "\n");

const total = records.reduce((s, r) => s + r.revenue, 0);
console.log(
  `generated: ${records.length} sales records, ${targets.length} targets (total revenue ${(total / 1e8).toFixed(1)} hundred-million yen, content ${meta.contentHash.slice(0, 19)}…)`,
);

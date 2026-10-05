import type { UsageRow } from "@kohaku-ui/lineage";

/** The fixed CSV header of `kohaku usage export --format csv` (column order is part of the contract). */
export const USAGE_CSV_HEADER = [
  "day",
  "tenant",
  "composed",
  "cache_hit",
  "cache_miss",
  "cache_bypass",
  "cache_fixated",
  "l0",
  "l1",
  "l2",
  "l2_generated",
  "fallbacks",
  "tokens_in",
  "tokens_out",
  "fixations_created",
  "fixations_removed",
] as const;

/** RFC 4180 quoting: a field containing a comma, a double quote, CR or LF is wrapped in quotes, with embedded quotes doubled. */
function csvField(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The tenant column carries a value the host's callers chose, and a spreadsheet reads a cell that starts with
 * `=`, `+`, `-` or `@` (or a tab / carriage return) as a formula. A leading apostrophe makes it plain text
 * there (the usual CSV-injection guard); the quoting above still applies on top.
 */
function tenantField(tenant: string): string {
  return /^[=+\-@\t\r]/.test(tenant) ? `'${tenant}` : tenant;
}

/**
 * Formats usage rows as CSV: the fixed header, then one line per row (lines end in LF, with a trailing
 * newline). An empty row list yields the header alone.
 */
export function formatUsageCsv(rows: readonly UsageRow[]): string {
  const lines = [USAGE_CSV_HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.day,
        tenantField(r.tenant),
        r.composed,
        r.cache.hit,
        r.cache.miss,
        r.cache.bypass,
        r.cache.fixated,
        r.tiers.L0,
        r.tiers.L1,
        r.tiers.L2,
        r.l2Generated,
        r.fallbacks,
        r.tokens.input,
        r.tokens.output,
        r.fixationsCreated,
        r.fixationsRemoved,
      ]
        .map(csvField)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

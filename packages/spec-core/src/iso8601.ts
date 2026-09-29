/**
 * ISO8601 validation + canonicalization of a since / until value. Date.parse broadly accepts non-ISO forms like
 * "July 9, 2026" and interprets them in the local TZ, making them environment-dependent, so restrict the format to
 * ISO8601 (extended notation). Values with a time require a timezone (Z / ±hh:mm) (an unspecified one is
 * non-deterministic under local interpretation). Date-only is interpreted as UTC (ES spec), which is deterministic.
 * The return value is ISO8601 canonical form (`Date#toISOString`). null if invalid.
 *
 * StoragePort compares since / until against event timestamps as strings, so every caller that hands a
 * user-supplied window to a StoragePort (the REST `/lineage` route, `kohaku evidence export`) canonicalizes
 * with this first.
 */
const ISO8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:\d{2}))?$/;

export function parseIso8601(raw: string): string | null {
  if (!ISO8601_PATTERN.test(raw)) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

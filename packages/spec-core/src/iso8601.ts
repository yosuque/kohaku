/**
 * ISO8601 validation + canonicalization of a since / until value. Date.parse broadly accepts non-ISO forms like
 * "July 9, 2026" and interprets them in the local TZ, making them environment-dependent, so restrict the format to
 * ISO8601 (extended notation). Values with a time require a timezone (Z / ±hh:mm) (an unspecified one is
 * non-deterministic under local interpretation). Date-only is interpreted as UTC (ES spec), which is deterministic.
 * The return value is ISO8601 canonical form (`Date#toISOString`). null if invalid, including an impossible
 * calendar date such as `2026-02-30` (which `Date.parse` would silently roll over to March 2nd).
 *
 * StoragePort compares since / until against event timestamps as strings, so every caller that hands a
 * user-supplied window to a StoragePort (the REST `/lineage` route, `kohaku evidence export`) canonicalizes
 * with this first.
 */
const ISO8601_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:[Zz]|[+-](\d{2}):(\d{2})))?$/;

/** Date.parse rolls an impossible calendar date over ("2026-02-30" becomes March 2nd, "T24:00" the next day); the fields are checked first so it is rejected instead. */
function fieldsInRange(m: RegExpExecArray): boolean {
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const calendar = new Date(Date.UTC(2000, month - 1, day));
  calendar.setUTCFullYear(year);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    return false;
  }
  const hour = m[4] == null ? 0 : Number(m[4]);
  const minute = m[5] == null ? 0 : Number(m[5]);
  const second = m[6] == null ? 0 : Number(m[6]);
  const offsetHour = m[7] == null ? 0 : Number(m[7]);
  const offsetMinute = m[8] == null ? 0 : Number(m[8]);
  return hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59;
}

export function parseIso8601(raw: string): string | null {
  const m = ISO8601_PATTERN.exec(raw);
  if (m == null || !fieldsInRange(m)) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

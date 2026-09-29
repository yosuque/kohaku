import { parseIso8601 } from "@kohaku-ui/spec-core";

/** A bad `kohaku evidence export` argument (exit code 2, like `evidence verify`'s usage errors). */
export class EvidenceUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceUsageError";
  }
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Date.parse rolls an out-of-range day over ("2026-02-30" is March 2nd); refuse it instead. */
function isRealCalendarDate(raw: string): boolean {
  const m = DATE_ONLY_PATTERN.exec(raw.slice(0, 10));
  if (m == null) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function canonicalBound(flag: "--since" | "--until", raw: string): string {
  const canonical = parseIso8601(raw);
  if (canonical == null || !isRealCalendarDate(raw)) {
    throw new EvidenceUsageError(
      `${flag} must be an ISO 8601 date (YYYY-MM-DD) or timestamp with a Z or ±hh:mm offset, got "${raw}"`,
    );
  }
  return canonical;
}

/**
 * Validates and canonicalizes `--since` / `--until` the way the REST `/lineage` route does (a StoragePort
 * compares them to event timestamps as strings, so an offset like `+09:00`, or a bare date, matches the
 * wrong events unless normalized to canonical UTC first).
 *
 * A date-only value is a whole UTC day: `--since 2026-09-01` starts at 00:00:00.000Z and, so that
 * `--until 2026-09-30` does not silently drop the last day, a date-only `--until` ends at 23:59:59.999Z.
 * The resulting instants are what the manifest records as `scope.since` / `scope.until`.
 */
export function resolveEvidenceWindow(opts: { since: string; until: string }): {
  since: string;
  until: string;
} {
  const since = canonicalBound("--since", opts.since);
  let until = canonicalBound("--until", opts.until);
  if (DATE_ONLY_PATTERN.test(opts.until)) {
    until = `${opts.until}T23:59:59.999Z`;
  }
  if (since > until) {
    throw new EvidenceUsageError(`--since (${since}) is after --until (${until})`);
  }
  return { since, until };
}

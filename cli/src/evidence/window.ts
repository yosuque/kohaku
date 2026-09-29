import { parseIso8601 } from "@kohaku-ui/spec-core";

/** A bad `kohaku evidence export` argument (exit code 2, like `evidence verify`'s usage errors). */
export class EvidenceUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceUsageError";
  }
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function canonicalBound(flag: "--since" | "--until", raw: string): string {
  const canonical = parseIso8601(raw);
  if (canonical == null) {
    throw new EvidenceUsageError(
      `${flag} must be an ISO 8601 date (YYYY-MM-DD) or timestamp with a Z or ±hh:mm offset, got "${raw}"`,
    );
  }
  return canonical;
}

/**
 * Validates and canonicalizes `--since` / `--until` with the same `parseIso8601` the REST `/lineage` route
 * uses (a StoragePort compares them to event timestamps as strings, so an offset like `+09:00`, or a bare
 * date, matches the wrong events unless normalized to canonical UTC first). The one deliberate difference
 * from REST is a date-only `--until`: REST reads it as the instant 00:00:00.000Z of that day, this CLI as
 * the whole day (below).
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

import { parseIso8601 } from "@kohaku-ui/spec-core";
import { CliUsageError } from "./usage-error.js";

/**
 * The lineage source and window of a lineage-reading subcommand (`evidence export`, `usage export`):
 * `dataDir` and `rest` are mutually exclusive, and `since` / `until` are validated by `resolveWindow`.
 */
export interface LineageSourceArgs {
  /** Read from a local StoragePort data directory (mutually exclusive with `rest`). */
  dataDir?: string;
  /**
   * Read over REST from a running host (mutually exclusive with `dataDir`). The `x-kohaku-tenant` header
   * decides the tenant scope; a host without tenant scoping returns every tenant.
   */
  rest?: string;
  /** Extra REST request headers ("name:value", repeatable) -- e.g. tenant / auth. REST mode only. */
  headers?: string[];
  tenant?: string;
  /** Lower bound: ISO 8601 date or timestamp; a date-only value starts that UTC day (see `resolveWindow`). */
  since: string;
  /** Upper bound: ISO 8601 date or timestamp; a date-only value INCLUDES that whole UTC day. */
  until: string;
}

/**
 * The commander option bag behind `LineageSourceArgs`: the six options both subcommands declare, with the
 * repeatable `--header` accumulated into `header`.
 */
export interface LineageSourceCliOptions {
  dataDir?: string;
  rest?: string;
  header: string[];
  tenant?: string;
  since: string;
  until: string;
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function canonicalBound(flag: "--since" | "--until", raw: string): string {
  const canonical = parseIso8601(raw);
  if (canonical == null) {
    throw new CliUsageError(
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
 * The resulting instants are what the evidence manifest records as `scope.since` / `scope.until`.
 */
export function resolveWindow(opts: { since: string; until: string }): {
  since: string;
  until: string;
} {
  const since = canonicalBound("--since", opts.since);
  let until = canonicalBound("--until", opts.until);
  if (DATE_ONLY_PATTERN.test(opts.until)) {
    until = `${opts.until}T23:59:59.999Z`;
  }
  if (since > until) {
    throw new CliUsageError(`--since (${since}) is after --until (${until})`);
  }
  return { since, until };
}

/**
 * In `--rest` mode, `--tenant` cannot by itself scope the export -- the request headers do (a
 * REST-sourced read only ever sees whatever the transport actually sends). Resolves the tenant label from the
 * `x-kohaku-tenant` header (case-insensitive, matching apps/sample-api's own convention in
 * request-identity.ts, which is a product convention, not a protocol-level guarantee) and rejects a
 * `--tenant` that disagrees with it (or has no header to back it), so the two can never silently diverge --
 * an auditor reading `scope.tenant` must be able to trust it reflects the actual REST scope, not just
 * whatever label the caller happened to type. Both rejections are usage errors (exit 2).
 */
export function resolveRestTenant(
  headers: Record<string, string>,
  requestedTenant: string | undefined,
): string | undefined {
  const headerEntry = Object.entries(headers).find(([name]) => name.toLowerCase() === "x-kohaku-tenant");
  const headerTenant = headerEntry?.[1];
  if (headerTenant == null) {
    if (requestedTenant != null) {
      throw new CliUsageError(
        `--tenant ${requestedTenant} was given but no x-kohaku-tenant header was supplied; in --rest ` +
          `mode the header determines the actual scope, so pass ` +
          `--header "x-kohaku-tenant:${requestedTenant}" as well`,
      );
    }
    return undefined;
  }
  if (requestedTenant != null && requestedTenant !== headerTenant) {
    throw new CliUsageError(
      `--tenant ${requestedTenant} conflicts with the x-kohaku-tenant header (${headerTenant}); the ` +
        "header determines the actual REST scope, so remove --tenant or make it match",
    );
  }
  return headerTenant;
}

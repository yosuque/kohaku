// Dependency-free parser for repeated `--header name:value` flags, shared by `explain`, `evidence export` and
// `usage export`. It lives apart from `commands.ts` so that importing it does not drag in the heavy workspace
// packages (client, composer, evals, sandbox, ...) that `commands.ts` pulls in.

import { CliUsageError } from "./usage-error.js";

/**
 * Parses repeated `--header name:value` flags into a headers record. Throws a `CliUsageError` (exit 2) on a
 * malformed entry (no `:`, or an empty name) so a typo is caught at the CLI boundary rather than silently
 * sending a broken header.
 */
export function parseHeaderArgs(headers: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    const idx = h.indexOf(":");
    if (idx <= 0) {
      throw new CliUsageError(`--header must be given as "name:value" (got "${h}")`);
    }
    out[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }
  return out;
}

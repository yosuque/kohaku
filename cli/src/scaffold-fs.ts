// Light, dependency-free helpers shared by the scaffold-writing commands (`init`, `scaffold`) and the
// evidence exporter. They live apart from `commands.ts` so that importing them does not drag in the heavy
// workspace packages (client, composer, evals, sandbox, ...) that `commands.ts` pulls in.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Parses repeated `--header name:value` flags into a headers record. Throws on a malformed entry (no `:`, or
 * an empty name) so a typo is caught at the CLI boundary rather than silently sending a broken header.
 */
export function parseHeaderArgs(headers: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    const idx = h.indexOf(":");
    if (idx <= 0) {
      throw new Error(`--header must be given as "name:value" (got "${h}")`);
    }
    out[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }
  return out;
}

/**
 * Generate the scaffold files atomically (check-all-then-write).
 * Atomicity is required to honor "never overwrite". Checking existence while writing would, in a
 * directory where only one of the files already exists, leave the other partially generated. So we
 * check every file's existence first (check-all) and only then write (then-write). We create each
 * parent directory on demand so that placement in subdirectories is also allowed.
 */
export function writeScaffold(files: readonly (readonly [string, string])[]): string[] {
  for (const [path] of files) {
    if (existsSync(path)) {
      throw new Error(`${path} already exists (will not overwrite)`);
    }
  }
  const written: string[] = [];
  for (const [path, content] of files) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    written.push(path);
  }
  return written;
}

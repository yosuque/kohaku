// Light, dependency-free scaffold writer shared by the scaffold-writing commands (`init`, `scaffold`). It
// lives apart from `commands.ts` so that importing it does not drag in the heavy workspace packages
// (client, composer, evals, sandbox, ...) that `commands.ts` pulls in.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

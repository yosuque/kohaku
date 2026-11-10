/**
 * The supported Node floor, read from `.node-version` — the single source of truth for it.
 *
 * CI verifies exactly one Node version (every workflow's setup-node uses `node-version-file: .node-version`),
 * and the `engines.node` range every published package, the root package.json and the `kohaku init` project
 * declare is `>=` that same version (written by `pnpm meta:sync` and `pnpm init:versions`). So the declared
 * floor is always the version CI actually ran, and raising it is: edit `.node-version`, `pnpm regen`, and a
 * changeset (it is a breaking change for consumers on an older Node). See CONTRIBUTING.md §2.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {string} repoRoot Absolute path of the repository root.
 * @returns {string} The exact version in `.node-version`, e.g. "26.12.1".
 * @throws {Error} When the file does not hold a plain `X.Y.Z` version.
 */
export function readNodeVersion(repoRoot) {
  const raw = readFileSync(join(repoRoot, ".node-version"), "utf8").trim();
  if (!/^\d+\.\d+\.\d+$/.test(raw)) {
    throw new Error(`.node-version must hold an exact X.Y.Z version (it is the Node floor), got "${raw}"`);
  }
  return raw;
}

/**
 * @param {string} repoRoot Absolute path of the repository root.
 * @returns {string} The `engines.node` range, e.g. ">=26.12.1".
 */
export function nodeEnginesRange(repoRoot) {
  return `>=${readNodeVersion(repoRoot)}`;
}

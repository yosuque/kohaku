/**
 * Keeps the Python distribution's version in step with the TypeScript packages.
 *
 * The two implementations are one protocol implemented twice, and the conformance suite checks them
 * against each other; a user reading "kohaku 0.3.0" should get the same protocol behaviour in either
 * language. Changesets owns the TypeScript version (all twenty packages move together, so spec-core is a
 * fine stand-in for the set), and this script propagates it to the two places Python states it.
 *
 * Run by `pnpm version` as part of producing the release pull request, so the Python bump is reviewed in
 * the same diff. CI re-runs it and fails on any drift, like the other generated artifacts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const version = (
  JSON.parse(readFileSync(join(REPO_ROOT, "packages/spec-core/package.json"), "utf8")) as {
    version: string;
  }
).version;

const targets: { path: string; pattern: RegExp; replacement: string }[] = [
  {
    path: "python/kohaku/pyproject.toml",
    pattern: /^version = ".*"$/m,
    replacement: `version = "${version}"`,
  },
  {
    path: "python/kohaku/src/kohaku/__init__.py",
    pattern: /^__version__ = ".*"$/m,
    replacement: `__version__ = "${version}"`,
  },
];

for (const { path, pattern, replacement } of targets) {
  const full = join(REPO_ROOT, path);
  const before = readFileSync(full, "utf8");
  if (!pattern.test(before)) {
    console.error(`${path}: no version line matching ${pattern} — the file's shape changed`);
    process.exit(1);
  }
  const after = before.replace(pattern, replacement);
  if (after !== before) {
    writeFileSync(full, after);
    console.log(`${path}: set to ${version}`);
  }
}

console.log(`python version in sync with the TypeScript packages (${version})`);

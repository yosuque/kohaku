/**
 * Regenerates `cli/src/init/versions.ts` (the version table `kohaku init` pins in a generated project) from
 * the pnpm catalog, so a catalog bump — Dependabot's included — can no longer leave the table stale. It also
 * carries the generated project's `engines.node`, derived from `.node-version` (scripts/lib/node-floor.mjs).
 *
 * Run `pnpm init:versions`; CI re-runs it and fails on any diff, like the other generated artifacts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderInitVersions } from "./lib/init-versions.mjs";
import { nodeEnginesRange } from "./lib/node-floor.mjs";
import { readCatalog } from "./lib/read-catalog.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = "cli/src/init/versions.ts";

let output: string;
try {
  output = renderInitVersions(
    readCatalog(readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8")),
    nodeEnginesRange(REPO_ROOT),
  );
} catch (error) {
  console.error(`${TARGET}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const full = join(REPO_ROOT, TARGET);
if (readFileSync(full, "utf8") !== output) {
  writeFileSync(full, output);
  console.log(`${TARGET}: regenerated`);
} else {
  console.log(`${TARGET}: up to date`);
}

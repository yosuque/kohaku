/**
 * Keeps the publishable packages' manifests in sync, idempotently.
 *
 * Two things are derived rather than hand-written, because both are easy to get subtly wrong twenty
 * times over:
 *
 *  - the shared publishing metadata (license / repository.directory / files / engines / ...), and
 *  - `publishConfig.exports`, which is mechanically derived from the top-level `exports`.
 *
 * The top-level `exports` keeps pointing at `src/*.ts` so that the workspace (tsx / Vite / Vitest /
 * tsc) resolves TypeScript directly, exactly as before. pnpm applies `publishConfig` over the
 * manifest when it packs, so only the published tarball points at `dist`. Keeping the two in sync by
 * hand is how a subpath silently ships unresolvable; deriving it means adding an export entry is
 * enough.
 *
 * `description` is deliberately NOT generated: it is written by a human and this script never
 * overwrites an existing one. It only warns when one is missing.
 *
 * Run `pnpm meta:sync`; CI re-runs it and fails on any diff, like the other generated artifacts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_URL = "git+https://github.com/yosuque/kohaku.git";
const HOMEPAGE = "https://github.com/yosuque/kohaku";

/** Workspace directories whose packages are published to npm. `apps/*` are samples and stay private. */
const PUBLISHED_DIRS = [
  ...[
    "authz-hmac",
    "client",
    "composer",
    "data-binding",
    "evals",
    "host-a2ui",
    "host-core",
    "host-mcp-apps",
    "host-rest",
    "intents",
    "lineage",
    "llm",
    "otel",
    "registry",
    "renderer-core",
    "renderer-react",
    "renderer-wc",
    "sandbox",
    "spec-core",
    "storage-memory",
    "storage-postgres",
    "storage-redis",
  ].map((name) => `packages/${name}`),
  "cli",
  "spec",
];

type Json = Record<string, unknown>;

/** `./src/foo.ts` -> `./dist/foo.js`; `./conformance/index.ts` -> `./dist/index.js` (spec is flat). */
function toDist(sourcePath: string, suffix: ".js" | ".d.ts"): string {
  return sourcePath.replace(/^\.\/(src|conformance)\//, "./dist/").replace(/\.tsx?$/, suffix);
}

/** Derives the published `exports` map from the development one. JSON entries are passed through. */
function publishedExports(exports: Record<string, string>): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(exports)) {
    if (value.endsWith(".json")) {
      out[key] = value;
      continue;
    }
    out[key] = { types: toDist(value, ".d.ts"), default: toDist(value, ".js") };
  }
  out["./package.json"] = "./package.json";
  return out;
}

/** Rewrites `key`'s value in place, preserving its position; appends when absent. */
function setField(manifest: Json, key: string, value: unknown): void {
  manifest[key] = value;
}

let missingDescriptions = 0;

for (const dir of PUBLISHED_DIRS) {
  const manifestPath = join(REPO_ROOT, dir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Json;
  const exports = manifest["exports"] as Record<string, string>;

  if (typeof manifest["description"] !== "string" || manifest["description"] === "") {
    console.warn(`${manifest["name"] as string}: missing description (write one by hand)`);
    missingDescriptions++;
  }

  setField(manifest, "license", "Apache-2.0");
  setField(manifest, "homepage", `${HOMEPAGE}/tree/main/${dir}#readme`);
  setField(manifest, "bugs", { url: `${HOMEPAGE}/issues` });
  setField(manifest, "repository", { type: "git", url: REPO_URL, directory: dir });
  setField(manifest, "engines", { node: ">=22" });
  // Every library module is free of top-level side effects, so bundlers may drop unused ones. The CLI is
  // the exception: it is an executable whose entry parses argv and runs as soon as it is evaluated, which
  // is also why it publishes a bin and no importable entry point at all.
  setField(manifest, "sideEffects", manifest["bin"] !== undefined);
  // spec ships more than code: the normative document, the JSON Schemas derived from it, and the
  // example Spec that the conformance suite reads at run time through a path relative to its own
  // module (which is why its build output is flat under dist/, not dist/conformance/).
  const extraFiles = dir === "spec" ? ["examples", "schemas", "SPEC.md", "SPEC.ja.md"] : [];
  // Changesets writes CHANGELOG.md into a package once it has shipped a released version (0.1.1
  // on), so it is listed here too; a package that has no CHANGELOG.md yet on disk simply has
  // nothing there to pack — `files` entries that don't exist are silently skipped, not an error.
  setField(manifest, "files", ["dist", ...extraFiles, "LICENSE", "README.md", "CHANGELOG.md"]);

  const publishConfig = (manifest["publishConfig"] as Json | undefined) ?? {};
  publishConfig["access"] = "public";
  const main = exports?.["."];
  if (main !== undefined) {
    publishConfig["main"] = toDist(main, ".js");
    publishConfig["types"] = toDist(main, ".d.ts");
  }
  if (exports !== undefined) {
    publishConfig["exports"] = publishedExports(exports);
  }
  // The CLI's bin must point at compiled JavaScript once published: the checked-in bin/kohaku.js is a
  // tsx launcher for in-repo use and tsx is not a dependency of the published package.
  if (manifest["bin"] !== undefined) {
    publishConfig["bin"] = { kohaku: "./dist/index.js" };
  }
  setField(manifest, "publishConfig", publishConfig);

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log(`synced ${PUBLISHED_DIRS.length} manifests`);
if (missingDescriptions > 0) {
  console.error(`${missingDescriptions} package(s) still need a description`);
  process.exit(1);
}

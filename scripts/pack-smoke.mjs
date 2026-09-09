#!/usr/bin/env node
/**
 * Packed-tarball smoke test.
 *
 * Every other check in this repo (`pnpm test`, `pnpm typecheck`) looks at `src/*.ts` directly — packages
 * export source, not `dist`, so the workspace never resolves through `publishConfig`. That means none of the
 * existing tests ever notice a missing `publishConfig` entry, a `.d.ts` that references a path that does not
 * survive `pnpm pack`, or a guest closure (packages/sandbox) whose stringified source silently changes shape
 * under the build. This script is the only thing in the repo that installs the *published* artifact — a real
 * `npm install` of `pnpm pack` tarballs, outside the workspace and outside pnpm entirely — and exercises it.
 *
 * Steps (see docs at each phase below):
 *   1. Discover every publishable workspace package (anything under packages/*, cli, spec that has a
 *      `publishConfig`). Never hardcoded — a new published package is picked up automatically.
 *   2. `pnpm pack` each one (this runs each package's own `prepack` -> `build`).
 *   3. Inspect the tarball contents and the packed `package.json` (publishConfig applied, no leftover
 *      `workspace:`/`catalog:` protocol references, no `private`).
 *   4. Install every tarball plus the external peers into one throwaway consumer project with plain
 *      `npm install` (deliberately not pnpm — this is the only thing in the repo that proves the published
 *      manifests resolve on their own, outside the workspace).
 *   5. Dynamically `import()` every `publishConfig.exports` entry (except `.json` data exports) and check it
 *      has at least one named export.
 *   6. Type-check every entry under `moduleResolution: "nodenext"` with the repo's own `tsc` (`skipLibCheck:
 *      false`, so a broken reference inside a published `.d.ts` cannot hide behind a skipped lib check).
 *   7. Run the installed `kohaku` CLI binary (`conformance --self`) — proves the CLI's `bin` remapping and its
 *      production dependency on `@kohaku-ui/spec` (and `spec`'s own `examples/` relative path) survive
 *      packing.
 *   8. Sandbox guest contract check: `buildWorkerShimJs` is exported specifically because its return value is
 *      `Function.prototype.toString()`'d and evaluated as a standalone script inside a Worker (see
 *      packages/sandbox/src/guest/worker-shim.ts). A build that reshapes that function (renames captured
 *      variables it should not close over, wraps it, minifies away its "use strict" prologue, etc.) breaks
 *      this silently — no existing test stringifies the *compiled* function. We import the published dist,
 *      call the builder, and evaluate the result in a bare `node:vm` context with only the surface a real
 *      Worker global scope provides.
 *   9. `publint` and `@arethetypeswrong/cli` (best-effort: network-fetch failure is a warning, not a failure).
 *  10. Clean up the throwaway directories.
 *
 * Every step fails fast: the first problem found aborts the whole run with a clear diagnostic. This is
 * intentional — this script is a gate, and partial credit is not useful for a gate.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------

const startedAt = Date.now();
let tmpRoot = null;

function elapsed() {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

function log(message) {
  console.log(`[pack-smoke] ${message}`);
}

function step(n, title) {
  console.log(`\n[pack-smoke] === Step ${n}: ${title} (${elapsed()}) ===`);
}

function cleanup() {
  if (tmpRoot) {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch (err) {
      console.error(`[pack-smoke] warning: failed to clean up ${tmpRoot}: ${err}`);
    }
  }
}

/** Fail fast: print full diagnostics, clean up, exit non-zero. Never returns. */
function fail(message, details) {
  console.error(`\n[pack-smoke] FAILURE (${elapsed()}): ${message}`);
  if (details) {
    console.error(details);
  }
  cleanup();
  process.exit(1);
}

/** Run a command, capturing stdout/stderr. Does not throw on non-zero exit -- callers decide. */
function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: opts.cwd ?? REPO_ROOT,
    env: opts.env ?? process.env,
    maxBuffer: 1024 * 1024 * 64,
  });
  if (result.error) {
    fail(`could not run \`${cmd} ${args.join(" ")}\``, String(result.error));
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Like run(), but fails immediately on non-zero exit with the full command output. */
function runOrFail(cmd, args, opts = {}) {
  const result = run(cmd, args, opts);
  if (result.status !== 0) {
    fail(
      `\`${cmd} ${args.join(" ")}\` exited ${result.status}${opts.cwd ? ` (cwd: ${opts.cwd})` : ""}`,
      `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------
// Step 1: discover publishable packages (never hardcoded)
// ---------------------------------------------------------------------------------------------------------

function discoverPackages() {
  const candidateDirs = [
    ...readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `packages/${e.name}`),
    "cli",
    "spec",
  ];

  const packages = [];
  for (const rel of candidateDirs.sort()) {
    const dir = join(REPO_ROOT, rel);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!manifest.publishConfig) continue; // apps/* and anything not meant for npm stays out
    packages.push({ rel, dir, manifest });
  }
  return packages;
}

// ---------------------------------------------------------------------------------------------------------
// Step 2: pnpm pack each package (runs prepack -> build)
// ---------------------------------------------------------------------------------------------------------

function packAll(packages, tgzDir) {
  for (const pkg of packages) {
    log(`packing ${pkg.manifest.name} (${pkg.rel})`);
    const result = run("pnpm", ["pack", "--json", "--pack-destination", tgzDir], { cwd: pkg.dir });
    if (result.status !== 0) {
      fail(`pnpm pack failed for ${pkg.manifest.name}`, `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      fail(`pnpm pack --json produced non-JSON stdout for ${pkg.manifest.name}`, `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`);
    }
    pkg.tarball = parsed.filename;
    pkg.packedName = parsed.name;
    pkg.packedVersion = parsed.version;
    if (pkg.packedName !== pkg.manifest.name) {
      fail(`pnpm pack reported name "${pkg.packedName}" but package.json says "${pkg.manifest.name}"`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Step 3: inspect tarball contents + packed package.json
// ---------------------------------------------------------------------------------------------------------

const FORBIDDEN_PREFIXES = ["src/", "test/", "tests/"];

function checkTarballContents(pkg) {
  const listing = run("tar", ["-tzf", pkg.tarball]);
  if (listing.status !== 0) {
    fail(`tar -tzf failed for ${pkg.tarball}`, listing.stderr);
  }
  const files = listing.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^package\//, ""));

  if (!files.some((f) => f.startsWith("dist/"))) {
    fail(`${pkg.manifest.name}: tarball contains no dist/ files`, files.join("\n"));
  }
  for (const prefix of FORBIDDEN_PREFIXES) {
    const leaked = files.filter((f) => f.startsWith(prefix));
    if (leaked.length > 0) {
      fail(`${pkg.manifest.name}: tarball unexpectedly contains ${prefix}`, leaked.join("\n"));
    }
  }
  const leakedConfig = files.filter((f) => /^tsconfig.*\.json$/.test(f) || f === "vitest.config.ts");
  if (leakedConfig.length > 0) {
    fail(`${pkg.manifest.name}: tarball unexpectedly contains build/test config`, leakedConfig.join("\n"));
  }

  const pkgJsonResult = run("tar", ["-xOzf", pkg.tarball, "package/package.json"]);
  if (pkgJsonResult.status !== 0) {
    fail(`${pkg.manifest.name}: could not extract package/package.json from tarball`, pkgJsonResult.stderr);
  }
  let packedManifest;
  try {
    packedManifest = JSON.parse(pkgJsonResult.stdout);
  } catch {
    fail(`${pkg.manifest.name}: packed package.json is not valid JSON`, pkgJsonResult.stdout);
  }

  if ("private" in packedManifest) {
    fail(`${pkg.manifest.name}: packed package.json still has "private"`);
  }
  const raw = JSON.stringify(packedManifest);
  if (raw.includes("workspace:")) {
    fail(`${pkg.manifest.name}: packed package.json still has a "workspace:" protocol reference`, raw);
  }
  if (raw.includes("catalog:")) {
    fail(`${pkg.manifest.name}: packed package.json still has a "catalog:" protocol reference`, raw);
  }
  // A bin-only package (the CLI) publishes no importable entry at all -- its entry module parses argv and
  // runs on evaluation, so exposing it as an import would be a trap. For those, the bin is what has to
  // have been rewritten to dist/; for every library, the exports map is.
  const entryRaw = JSON.stringify(
    packedManifest.exports ?? packedManifest.main ?? packedManifest.bin ?? "",
  );
  if (!entryRaw.includes("dist/") && !entryRaw.includes("dist\\/")) {
    fail(`${pkg.manifest.name}: packed entry points do not point into dist/ (publishConfig not applied?)`, entryRaw);
  }

  pkg.packedManifest = packedManifest;
}

// ---------------------------------------------------------------------------------------------------------
// Step 4: consumer install (plain npm, outside the workspace)
// ---------------------------------------------------------------------------------------------------------

/** Parses `key: value` lines out of pnpm-workspace.yaml's catalog block (avoids a yaml dependency). */
function readCatalogVersion(workspaceYaml, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = workspaceYaml.match(new RegExp(`^\\s*"?${escaped}"?:\\s*(\\S.*)$`, "m"));
  if (!match) return null;
  return match[1].trim().replace(/^"(.*)"$/, "$1");
}

function collectExternalPeers(packages, workspaceYaml) {
  // Union of every package's own peerDependencies (already resolved to real semver by `pnpm pack`, no
  // catalog: left), plus the externals the task explicitly calls out even where nothing declares them as a
  // peer (react-dom: no package here peer-depends on it, but it is the natural companion of the "react"
  // peer every React-facing entry point expects a consumer to bring).
  const peers = {};
  for (const pkg of packages) {
    for (const [name, range] of Object.entries(pkg.packedManifest.peerDependencies ?? {})) {
      peers[name] = range;
    }
  }
  peers["react-dom"] = readCatalogVersion(workspaceYaml, "react-dom") ?? peers["react-dom"] ?? "^19.0.0";
  if (!peers["jsdom"]) {
    peers["jsdom"] = readCatalogVersion(workspaceYaml, "jsdom") ?? "*";
  }
  if (!peers["zod"]) {
    peers["zod"] = readCatalogVersion(workspaceYaml, "zod") ?? "^4.0.0";
  }
  // @types/react(-dom) are not runtime peers of anything, but the type-check step (6) needs them resolvable
  // for any entry whose .d.ts imports react's types (renderer-react, sandbox/react).
  if (peers["react"]) {
    peers["@types/react"] = readCatalogVersion(workspaceYaml, "@types/react") ?? "^19.0.0";
    peers["@types/react-dom"] = readCatalogVersion(workspaceYaml, "@types/react-dom") ?? "^19.0.0";
  }
  // @types/node: not a peer of anything either, but with skipLibCheck: false (step 6 deliberately does not
  // skip it) tsc also checks *dependencies'* .d.ts files -- and @modelcontextprotocol/server's own .d.ts
  // references the ambient `Buffer` type. Any real consumer of a server-side kohaku package (host-core /
  // host-rest / host-mcp-apps / cli all declare "types": ["node"] themselves, per this repo's own
  // convention) is expected to have @types/node in their own project already; this mirrors that.
  peers["@types/node"] = readCatalogVersion(workspaceYaml, "@types/node") ?? "*";
  return peers;
}

function installConsumer(packages, consumerDir, externalPeers) {
  const dependencies = {};
  for (const pkg of packages) {
    dependencies[pkg.packedName] = `file:${pkg.tarball}`;
  }
  Object.assign(dependencies, externalPeers);

  writeFileSync(
    join(consumerDir, "package.json"),
    JSON.stringify({ name: "kohaku-pack-smoke-consumer", type: "module", private: true, dependencies }, null, 2),
  );

  log(`npm install (${Object.keys(dependencies).length} dependencies: ${packages.length} local tarballs + ${Object.keys(externalPeers).length} external peers)`);
  runOrFail("npm", ["install", "--no-audit", "--no-fund"], { cwd: consumerDir });
}

// ---------------------------------------------------------------------------------------------------------
// Steps 5 & 6 share the same entry list: publishConfig.exports minus "./package.json" and minus any ".json"
// data export (e.g. spec's "./examples/quarterly-sales.spec.json" -- not a JS/TS module, nothing to import
// or type-check).
// ---------------------------------------------------------------------------------------------------------

function publicEntries(pkg) {
  const exportsMap = pkg.packedManifest.exports ?? {};
  const entries = [];
  const skipped = [];
  for (const [key, value] of Object.entries(exportsMap)) {
    if (key === "./package.json") continue;
    const defaultPath = typeof value === "string" ? value : value.default;
    if (typeof defaultPath === "string" && defaultPath.endsWith(".json")) {
      skipped.push(key);
      continue;
    }
    const specifier = key === "." ? pkg.packedName : `${pkg.packedName}/${key.slice(2)}`;
    entries.push({ pkgName: pkg.packedName, key, specifier });
  }
  if (skipped.length > 0) {
    log(`  (skipping non-JS export${skipped.length > 1 ? "s" : ""} of ${pkg.packedName}: ${skipped.join(", ")})`);
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------------------
// Step 5: runtime import check
// ---------------------------------------------------------------------------------------------------------

// Each entry is imported in its OWN child process, deliberately -- not batched into one script. A package
// whose main entry has a top-level side effect (import-time `process.exit()`, stdin reads, ...) would
// otherwise take the whole batch down with it and hide every other entry's result. This is not a
// theoretical concern: @kohaku-ui/cli's "." export is `cli/src/index.ts`, whose last line is a top-level
// `await program.parseAsync()` -- importing it runs commander against *our* argv and can call
// `process.exit()` before the import ever resolves. Isolating per entry turns that into one clearly
// attributed failure instead of a total step 5 crash.
function checkRuntimeImports(entries, consumerDir) {
  const scriptPath = join(consumerDir, "check-import-one.generated.mjs");
  writeFileSync(
    scriptPath,
    `
// The specifier travels via an env var, not argv -- a clean, empty argv is itself part of the test: a
// package whose entry point reads process.argv at import time (see the @kohaku-ui/cli note above) should
// see exactly what a normal \`import "pkg"\` caller's argv looks like, not our own test harness's arguments.
const specifier = process.env.PACK_SMOKE_SPECIFIER;

// A browser-targeted package can legitimately need DOM globals at module-evaluation time -- the Web
// Components renderer declares \`class KohakuSurface extends HTMLElement\` at module scope, which is
// evaluated the moment the module loads. That is correct for its target, so the check runs in two passes
// driven by the parent: a plain Node pass first (what a server-side consumer gets), and on a DOM
// ReferenceError a second child with PACK_SMOKE_DOM=1, which installs jsdom's globals BEFORE importing.
// It has to be a fresh process: ESM caches a module's instantiation failure, so retrying the same
// specifier in the same process just replays the original rejection.
if (process.env.PACK_SMOKE_DOM === "1") {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  for (const name of Object.getOwnPropertyNames(dom.window)) {
    if (globalThis[name] === undefined) {
      try {
        globalThis[name] = dom.window[name];
      } catch {
        // Some window properties are getter-only; skip them rather than aborting the whole setup.
      }
    }
  }
}

try {
  const mod = await import(specifier);
  const keys = Object.keys(mod);
  console.log(JSON.stringify({ ok: keys.length > 0, exportCount: keys.length, exportNames: keys, error: null }));
} catch (err) {
  const message = String((err && err.message) || err);
  const missingGlobal = err instanceof ReferenceError ? /(\\w+) is not defined/.exec(message)?.[1] : undefined;
  console.log(JSON.stringify({ ok: false, exportCount: 0, exportNames: [], missingGlobal: missingGlobal ?? null, error: String((err && err.stack) || err) }));
}
`,
  );

  /** Runs one entry in a fresh child; `withDom` installs jsdom's globals before the import. */
  const importOnce = (specifier, withDom) =>
    run("node", [scriptPath], {
      cwd: consumerDir,
      env: {
        ...process.env,
        PACK_SMOKE_SPECIFIER: specifier,
        ...(withDom ? { PACK_SMOKE_DOM: "1" } : {}),
      },
    });

  /** Parses one child's JSON line, or undefined when it did not produce one. */
  const tryParse = (stdout) => {
    try {
      return JSON.parse(stdout.trim());
    } catch {
      return undefined;
    }
  };
  const crashed = (entry, result) => ({
    ...entry,
    ok: false,
    exportCount: 0,
    exportNames: [],
    error: `child process exited ${result.status} without printing a result\n--- stdout ---\n${result.stdout}--- stderr ---\n${result.stderr}`,
  });

  const results = [];
  for (const entry of entries) {
    const plain = importOnce(entry.specifier, false);
    const parsed = plain.status === 0 ? tryParse(plain.stdout) : undefined;
    if (parsed === undefined) {
      results.push(crashed(entry, plain));
      continue;
    }
    if (parsed.ok || parsed.missingGlobal == null) {
      results.push({ ...entry, ...parsed });
      continue;
    }

    // Missing global on a plain Node import: this may be a browser-targeted package. Retry in a fresh
    // process with jsdom installed first -- a retry in the same process would replay the cached failure.
    const withDom = importOnce(entry.specifier, true);
    const domParsed = withDom.status === 0 ? tryParse(withDom.stdout) : undefined;
    if (domParsed === undefined) {
      results.push(crashed(entry, withDom));
      continue;
    }
    if (domParsed.ok) {
      results.push({ ...entry, ...domParsed, browserOnly: parsed.missingGlobal });
      continue;
    }
    results.push({
      ...entry,
      ...domParsed,
      error: `${parsed.missingGlobal} is missing in plain Node, and the import fails under jsdom too:\n${domParsed.error}`,
    });
  }

  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    fail(
      `${failures.length} export entr${failures.length > 1 ? "ies" : "y"} failed to import or had zero named exports`,
      failures.map((f) => `  ${f.specifier}:\n${f.error ?? "0 named exports"}`).join("\n\n"),
    );
  }
  for (const r of results) {
    const browser = r.browserOnly ? ` [browser-only: needs ${r.browserOnly}, imported under jsdom]` : "";
    log(`  import ok: ${r.specifier} (${r.exportCount} named exports)${browser}`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Step 6: NodeNext type resolution, checked with the repo's own tsc (falls back to tsc6 if tsc7 cannot do
// this at all -- see the CLAUDE.md pitfall about the repo running on TypeScript 7).
// ---------------------------------------------------------------------------------------------------------

function checkTypes(entries, consumerDir) {
  const lines = entries.map(
    (e, i) => `import type * as Mod_${i} from "${e.specifier}";\nconst _${i}: typeof Mod_${i} | undefined = undefined;\nvoid _${i};`,
  );
  writeFileSync(join(consumerDir, "check-types.generated.ts"), `${lines.join("\n")}\n`);
  writeFileSync(
    join(consumerDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "nodenext",
          moduleResolution: "nodenext",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          // Not just belt-and-suspenders: with skipLibCheck: false, tsc also checks *dependencies'* .d.ts
          // files, and @modelcontextprotocol/server's own .d.ts references the ambient `Buffer` type.
          // Without an explicit "types" array, tsc's automatic @types-folder discovery does not reliably
          // pull in @types/node's globals under nodenext (verified independently of this repo's own
          // packages). This mirrors the repo's own convention (CLAUDE.md: "Server-side packages set
          // `types: [\"node\"]` in tsconfig") rather than a workaround for a kohaku-specific problem.
          types: ["node"],
        },
        include: ["check-types.generated.ts"],
      },
      null,
      2,
    ),
  );

  const tsc7 = join(REPO_ROOT, "node_modules", ".bin", "tsc");
  const tsc6 = join(REPO_ROOT, "node_modules", ".bin", "tsc6");

  const first = run(tsc7, ["-p", "tsconfig.json"], { cwd: consumerDir });
  if (first.status === 0) {
    log("  type-checked with the repo's tsc (TypeScript 7)");
    return "tsc7";
  }

  log(`  tsc7 reported errors, retrying with tsc6 to see whether this is a tsc7-specific NodeNext limitation:\n${first.stdout}${first.stderr}`);
  if (!existsSync(tsc6)) {
    fail("NodeNext type-check failed under tsc7 and tsc6 is not installed to compare", `--- tsc7 stdout ---\n${first.stdout}\n--- tsc7 stderr ---\n${first.stderr}`);
  }
  const second = run(tsc6, ["-p", "tsconfig.json"], { cwd: consumerDir });
  if (second.status !== 0) {
    fail(
      "NodeNext type-check failed under both tsc7 and tsc6 (a real published-.d.ts problem, not a tsc7 quirk)",
      `--- tsc7 stdout ---\n${first.stdout}\n${first.stderr}\n--- tsc6 stdout ---\n${second.stdout}\n${second.stderr}`,
    );
  }
  log("  tsc7 failed but tsc6 passed -- used tsc6 (see stdout above for the tsc7 error, worth a follow-up)");
  return "tsc6";
}

// ---------------------------------------------------------------------------------------------------------
// Step 7: run the installed CLI binary
// ---------------------------------------------------------------------------------------------------------

function checkCli(consumerDir) {
  const bin = join(consumerDir, "node_modules", ".bin", "kohaku");
  if (!existsSync(bin)) {
    log("  @kohaku-ui/cli is not part of this smoke run's package set -- skipping the CLI check");
    return false;
  }
  runOrFail(bin, ["conformance", "--self"], { cwd: consumerDir });
  log("  `kohaku conformance --self` exited 0");
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// Step 8: sandbox guest contract check
// ---------------------------------------------------------------------------------------------------------

function checkSandboxGuestContract(packages, consumerDir) {
  if (!packages.some((p) => p.packedName === "@kohaku-ui/sandbox")) {
    log("  @kohaku-ui/sandbox is not part of this smoke run's package set -- skipping the guest contract check");
    return false;
  }
  const scriptPath = join(consumerDir, "check-sandbox.generated.mjs");
  writeFileSync(
    scriptPath,
    `
import { buildRuntimeJs, buildWorkerShimJs } from "@kohaku-ui/sandbox";
import vm from "node:vm";

const out = {};

// --- buildRuntimeJs: the trusted iframe's own inline script (what buildSrcdoc places inside the <script
// nonce> tag). It embeds domApplierMain.toString() directly at the top level, plus buildWorkerShimJs()'s
// output as an escaped JSON string value inside its config -- so unlike the Worker shim below, its natural
// habitat is a real DOM (domApplierMain touches \`document\`), not a bare node:vm context. We therefore only
// parse it (new vm.Script(), construct-only -- no .runInContext()) rather than execute it: this is exactly
// the check the guest closures need, because a build step reshaping Function.prototype.toString() output
// shows up as a SyntaxError at parse time regardless of whether the code ever runs.
{
  const config = {
    nonce: "check-nonce",
    rpcTimeoutMs: 1000,
    maxDomNodes: 1000,
    maxDomDepth: 1000,
    mutationsPerMinute: 1000,
    bodyHtml: "",
    scripts: "",
  };
  const source = buildRuntimeJs(config);
  out.runtimeJs = { sourceLength: source.length, hasUseStrict: source.includes('"use strict"'), parseError: null };
  try {
    new vm.Script(source, { filename: "runtime.js" });
  } catch (err) {
    out.runtimeJs.parseError = String((err && err.stack) || err);
  }
}

// --- buildWorkerShimJs: the Worker-side shim. Its natural habitat (no \`document\` of its own) is exactly
// what a bare node:vm context already provides, so here we go further than a parse-only check and actually
// run it -- mirrors packages/sandbox/test/guest/worker-shim.test.ts's bootWorker().
{
  const sandbox = {
    postMessage: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout,
    clearTimeout,
    queueMicrotask,
    console,
    Date,
  };
  const context = vm.createContext(sandbox);
  context.self = context;
  const config = { rpcTimeoutMs: 5000, viewportWidth: 800, bodyHtml: "" };
  const source = buildWorkerShimJs(config);
  out.workerShimJs = { sourceLength: source.length, hasUseStrict: source.includes('"use strict"'), runError: null };
  try {
    vm.runInContext(source, context, { filename: "worker-shim.js" });
  } catch (err) {
    out.workerShimJs.runError = String((err && err.stack) || err);
  }
}

console.log(JSON.stringify(out));
`,
  );
  const result = run("node", [scriptPath], { cwd: consumerDir });
  if (result.status !== 0) {
    fail("the sandbox guest-contract check script crashed", `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim().split("\n").pop());
  } catch {
    fail("could not parse sandbox guest-contract check output", `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`);
  }

  if (parsed.runtimeJs.parseError) {
    fail("buildRuntimeJs()'s output failed to parse as JS (new vm.Script())", parsed.runtimeJs.parseError);
  }
  if (!parsed.runtimeJs.hasUseStrict) {
    fail('buildRuntimeJs()\'s output no longer contains a "use strict" prologue -- the build reshaped the stringified guest closure(s)');
  }
  log(`  buildRuntimeJs() parsed cleanly (${parsed.runtimeJs.sourceLength} chars, "use strict" intact)`);

  if (parsed.workerShimJs.runError) {
    fail("buildWorkerShimJs()'s output failed to evaluate in a bare node:vm Worker-like context", parsed.workerShimJs.runError);
  }
  if (!parsed.workerShimJs.hasUseStrict) {
    fail('buildWorkerShimJs()\'s output no longer contains the guest closure\'s "use strict" prologue -- the build reshaped the stringified function');
  }
  log(`  buildWorkerShimJs() evaluated cleanly in node:vm (${parsed.workerShimJs.sourceLength} chars, "use strict" intact)`);
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// Step 9: publint + attw (best-effort -- a network-fetch failure to obtain the tool itself is a warning,
// not a failure; a real finding from either tool is a failure like everything else in this script).
// ---------------------------------------------------------------------------------------------------------

function resolveAuditTool(binName, npxPackage) {
  const localBin = join(REPO_ROOT, "node_modules", ".bin", binName);
  if (existsSync(localBin)) {
    return { cmd: localBin, prefixArgs: [], local: true };
  }
  return { cmd: "npx", prefixArgs: ["--yes", npxPackage], local: false };
}

const NETWORK_FAILURE_RE = /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|network timeout|code E\d{3}|404 Not Found - GET/i;

function runAudit(tool, args, toolBannerRe) {
  const result = run(tool.cmd, [...tool.prefixArgs, ...args]);
  const combined = `${result.stdout}\n${result.stderr}`;
  if (!tool.local && result.status !== 0 && NETWORK_FAILURE_RE.test(combined) && !toolBannerRe.test(combined)) {
    return { skipped: true, output: combined };
  }
  return { skipped: false, ok: result.status === 0, output: combined };
}

function checkPublintAndAttw(packages) {
  let anySkipped = false;
  for (const pkg of packages) {
    const publint = resolveAuditTool("publint", "publint");
    const publintResult = runAudit(publint, ["run", pkg.tarball], /Running publint/i);
    if (publintResult.skipped) {
      log(`  publint: SKIPPED for ${pkg.packedName} (could not fetch the tool over the network)`);
      anySkipped = true;
    } else if (!publintResult.ok) {
      fail(`publint reported a problem for ${pkg.packedName}`, publintResult.output);
    } else {
      log(`  publint ok: ${pkg.packedName}${publint.local ? "" : " (via npx)"}`);
    }

    // attw only has something to say about importable entry points. A bin-only package (the CLI)
    // publishes none on purpose, and attw reports that absence as "resolution failed" -- correct for a
    // library, meaningless here.
    if (pkg.manifest.exports === undefined) {
      log(`  attw: not applicable to ${pkg.packedName} (bin-only package, no importable entry)`);
      continue;
    }

    const attw = resolveAuditTool("attw", "@arethetypeswrong/cli");
    const attwResult = runAudit(attw, [pkg.tarball, "--profile", "esm-only"], /ATTW CLI/i);
    if (attwResult.skipped) {
      log(`  attw: SKIPPED for ${pkg.packedName} (could not fetch the tool over the network)`);
      anySkipped = true;
    } else if (!attwResult.ok) {
      fail(`@arethetypeswrong/cli reported a problem for ${pkg.packedName}`, attwResult.output);
    } else {
      log(`  attw ok: ${pkg.packedName}${attw.local ? "" : " (via npx)"}`);
    }
  }
  return { anySkipped };
}

// ---------------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------------

function main() {
  const workspaceYaml = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");

  step(1, "discover publishable packages");
  const packages = discoverPackages();
  if (packages.length === 0) {
    fail("no publishable packages found (nothing under packages/*, cli, spec has a publishConfig)");
  }
  log(`found ${packages.length} publishable packages: ${packages.map((p) => p.manifest.name).join(", ")}`);

  tmpRoot = mkdtempSync(join(tmpdir(), "kohaku-pack-smoke-"));
  const tgzDir = join(tmpRoot, "tgz");
  const consumerDir = join(tmpRoot, "consumer");
  mkdirSync(tgzDir, { recursive: true });
  mkdirSync(consumerDir, { recursive: true });
  log(`working directory: ${tmpRoot}`);

  step(2, "pnpm pack every package (runs each prepack -> build)");
  packAll(packages, tgzDir);

  step(3, "inspect tarball contents and the packed package.json");
  for (const pkg of packages) {
    checkTarballContents(pkg);
    log(`  ${pkg.manifest.name}: dist/ present, no src/test/build-config leak, publishConfig applied`);
  }

  step(4, "install every tarball + external peers with plain npm (outside pnpm, outside the workspace)");
  const externalPeers = collectExternalPeers(packages, workspaceYaml);
  installConsumer(packages, consumerDir, externalPeers);

  const entries = packages.flatMap((pkg) => publicEntries(pkg));

  step(5, `runtime import check (${entries.length} export entries)`);
  checkRuntimeImports(entries, consumerDir);

  step(6, `NodeNext type resolution check (${entries.length} export entries)`);
  const tscUsed = checkTypes(entries, consumerDir);

  step(7, "run the installed kohaku CLI (conformance --self)");
  const cliChecked = checkCli(consumerDir);

  step(8, "sandbox guest contract check (buildWorkerShimJs evaluated in node:vm)");
  const sandboxChecked = checkSandboxGuestContract(packages, consumerDir);

  step(9, "publint + @arethetypeswrong/cli (best-effort)");
  const { anySkipped } = checkPublintAndAttw(packages);

  step(10, "clean up");
  cleanup();
  tmpRoot = null;

  console.log(`\n[pack-smoke] ALL CHECKS PASSED (${elapsed()})`);
  console.log(`[pack-smoke]   packages checked: ${packages.length}`);
  console.log(`[pack-smoke]   export entries checked: ${entries.length}`);
  console.log(`[pack-smoke]   type-checked with: ${tscUsed === "tsc7" ? "TypeScript 7 (node_modules/.bin/tsc)" : "TypeScript 6 (node_modules/.bin/tsc6, tsc7 fallback)"}`);
  console.log(`[pack-smoke]   CLI check: ${cliChecked ? "ran" : "skipped (cli not in this package set)"}`);
  console.log(`[pack-smoke]   sandbox guest contract check: ${sandboxChecked ? "ran" : "skipped (sandbox not in this package set)"}`);
  console.log(`[pack-smoke]   publint/attw: ${anySkipped ? "ran, with some tools skipped (no network access to fetch them)" : "ran fully"}`);
}

try {
  main();
} catch (err) {
  fail("unexpected error", err && err.stack ? err.stack : String(err));
}

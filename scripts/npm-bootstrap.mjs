#!/usr/bin/env node
/**
 * First-publish bootstrap for publishable packages that do not exist on npm yet.
 *
 * `release.yml` publishes every package by npm trusted publishing (OIDC) only -- there is no token
 * fallback. But npm can only attach a trusted publisher to a package that already exists on the
 * registry ("Package must exist", `npm help trust`), so a brand-new package can never make its own
 * first publish through the workflow: the OIDC exchange answers 404 and the run stops (this is how the
 * 0.3.0 release failed on `@kohaku-ui/authz-hmac`). This script closes that gap, run once by a
 * maintainer logged in to npm, before the release that first ships the new package:
 *
 *   1. publishes a placeholder `0.0.0-bootstrap.0` (manifest + README only, dist-tag `bootstrap`) so
 *      the package name exists,
 *   2. registers the trusted publisher (`npm trust github`) for this repository, `release.yml` and the
 *      `npm` environment,
 *   3. deprecates the placeholder so nobody installs it by accident.
 *
 * The real version is then published by `release.yml` with provenance, like every other package, and
 * becomes `latest`.
 *
 * Usage:
 *   node scripts/npm-bootstrap.mjs                    # read-only: list which packages are missing on npm
 *   node scripts/npm-bootstrap.mjs --publish          # bootstrap every missing package (needs `npm login`)
 *   node scripts/npm-bootstrap.mjs --publish --dry-run  # print the npm commands instead of running them
 *   options: --root <dir> (default: repo root), --registry <url> (default: https://registry.npmjs.org)
 *
 * Re-running is safe: a package whose only versions are placeholders is never published again. If its
 * placeholder is not deprecated yet (an earlier run stopped part-way), `--publish` resumes with the
 * trusted-publisher and deprecate steps.
 *
 * Exit codes: list mode exits 1 when any package is missing or has an unfinished bootstrap (so it can
 * gate a checklist), 0 otherwise. `--publish` exits 1 when a publish or a fresh trust registration fails.
 *
 * ESM, `node:*` only -- no dependencies.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PLACEHOLDER_VERSION = "0.0.0-bootstrap.0";
export const PLACEHOLDER_TAG = "bootstrap";
/** Must match what npm's trusted publisher is registered against (docs/runbooks/release.md §2). */
export const WORKFLOW_FILE = "release.yml";
export const ENVIRONMENT = "npm";

/**
 * Returns `[{ dir, name, manifest }]` for every publishable package under `root`, sorted by name. The
 * rule is the same one `release.yml`'s trusted-publisher probe and `scripts/release-notes.mjs` use:
 * `packages/*`, `cli` and `spec`, with a `publishConfig` and not `private`.
 */
export function discoverPublishablePackages(root) {
  const candidateDirs = [];
  const packagesDir = join(root, "packages");
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) candidateDirs.push(join("packages", entry.name));
    }
  }
  candidateDirs.push("cli", "spec");

  const packages = [];
  for (const rel of candidateDirs) {
    const dir = join(root, rel);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!manifest.publishConfig || manifest.private) continue;
    packages.push({ dir, name: manifest.name, manifest });
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return packages;
}

/**
 * The registry URL path segment of a package name: `@scope/name` becomes `@scope%2Fname` (the form the
 * registry documents), anything else is percent-encoded as a whole. Encoding the part after the leading
 * `@` -- rather than encoding everything and patching the `@` back afterwards -- leaves no escape
 * sequence to undo.
 */
export function registryPath(name) {
  return name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

/**
 * Where a package stands on the registry:
 *   - `missing`: the name does not exist (HTTP 404) -- needs the full bootstrap;
 *   - `placeholder`: only `0.0.0-bootstrap.*` versions exist -- bootstrapped, waiting for its first real
 *     release; `deprecated` tells whether the last bootstrap step finished;
 *   - `published`: at least one real version exists -- nothing to do.
 * Throws on any other status rather than guessing.
 */
export async function registryState(name, registry, { write = false } = {}) {
  const url = `${registry.replace(/\/$/, "")}/${registryPath(name)}${write ? "?write=true" : ""}`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.npm.install-v1+json", "Cache-Control": "no-cache" },
  });
  if (res.status === 404) return { state: "missing", deprecated: false };
  if (res.status !== 200) throw new Error(`GET ${url} answered HTTP ${res.status}`);
  const versions = (await res.json()).versions ?? {};
  const names = Object.keys(versions);
  if (names.length > 0 && names.every((v) => v.startsWith("0.0.0-bootstrap."))) {
    return { state: "placeholder", deprecated: Boolean(versions[PLACEHOLDER_VERSION]?.deprecated) };
  }
  return { state: "published", deprecated: false };
}

/**
 * Waits until a just-published package is readable. The registry answers 404 for a new name for a while
 * after the PUT succeeds (observed: still 404 ~40 s later), and `npm deprecate` -- which reads the
 * package first, from the uncached `?write=true` document -- fails in that window. That is the document
 * polled here, since the cached one can turn readable earlier.
 */
async function waitUntilVisible(name, registry, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await registryState(name, registry, { write: true })).state !== "missing") return true;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return false;
}

/** `owner/repo` from a `repository.url` like `git+https://github.com/owner/repo.git`. */
export function githubRepoSlug(manifest) {
  const url = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url ?? "");
  if (!match) throw new Error(`${manifest.name}: cannot derive a GitHub owner/repo from repository "${url}"`);
  return match[1];
}

/** The placeholder manifest: enough for npm to accept it, nothing that could be mistaken for the package. */
export function placeholderManifest(manifest) {
  return {
    name: manifest.name,
    version: PLACEHOLDER_VERSION,
    description: `Placeholder that reserves the name before the first real release of ${manifest.name}. Do not install.`,
    license: manifest.license,
    repository: manifest.repository,
  };
}

/** The npm commands of the three bootstrap steps, as argv arrays (`dir` is the placeholder's directory). */
export function bootstrapCommands(manifest, dir, registry) {
  const reg = ["--registry", registry];
  return {
    publish: ["npm", "publish", dir, "--access", "public", "--tag", PLACEHOLDER_TAG, ...reg],
    trust: [
      "npm",
      "trust",
      "github",
      manifest.name,
      "--file",
      WORKFLOW_FILE,
      "--repository",
      githubRepoSlug(manifest),
      "--environment",
      ENVIRONMENT,
      "--allow-publish",
      "--yes",
      ...reg,
    ],
    deprecate: [
      "npm",
      "deprecate",
      `${manifest.name}@${PLACEHOLDER_VERSION}`,
      "Placeholder for the first trusted-publishing release; install a real version instead.",
      ...reg,
    ],
  };
}

function parseArgs(argv) {
  const opts = {
    root: join(dirname(fileURLToPath(import.meta.url)), ".."),
    registry: "https://registry.npmjs.org",
    publish: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--publish") opts.publish = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--root") opts.root = argv[++i];
    else if (arg === "--registry") opts.registry = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  // npm's 2FA for publish / trust / deprecate is an interactive browser handshake that npm only waits
  // for on a real terminal; without one it fails every command with EOTP. Refuse up front instead of
  // failing on the first package (an agent's shell or a CI step is not a terminal).
  if (opts.publish && !opts.dryRun && !(process.stdin.isTTY && process.stdout.isTTY)) {
    console.error(
      "--publish needs an interactive terminal: npm's two-factor authentication waits for a browser login only on a TTY. Run it from your own terminal (or pass --dry-run to only print the commands).",
    );
    return 1;
  }
  const packages = discoverPublishablePackages(opts.root);
  const todo = [];
  for (const pkg of packages) {
    const { state, deprecated } = await registryState(pkg.name, opts.registry);
    const label =
      state === "missing" ? "MISSING  " : state === "published" ? "exists   " : deprecated ? "bootstrap" : "BOOTSTRAP";
    console.log(`${label}  ${pkg.name}${state === "placeholder" && !deprecated ? " (unfinished)" : ""}`);
    if (state === "missing" || (state === "placeholder" && !deprecated)) todo.push({ ...pkg, state });
  }

  if (!opts.publish) {
    if (todo.length > 0) {
      console.log(
        `\n${todo.length} package(s) are missing on npm or have an unfinished bootstrap. Bootstrap them before the release:\n  node scripts/npm-bootstrap.mjs --publish`,
      );
      return 1;
    }
    return 0;
  }

  /** Runs one npm command; returns whether it succeeded. */
  const exec = ([cmd, ...args]) => {
    console.log(`$ ${[cmd, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
    if (opts.dryRun) return true;
    return spawnSync(cmd, args, { stdio: "inherit" }).status === 0;
  };

  for (const pkg of todo) {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-npm-bootstrap-"));
    try {
      const commands = bootstrapCommands(pkg.manifest, dir, opts.registry);
      console.log(`\n# ${pkg.name}`);
      if (pkg.state === "missing") {
        writeFileSync(join(dir, "package.json"), `${JSON.stringify(placeholderManifest(pkg.manifest), null, 2)}\n`);
        writeFileSync(
          join(dir, "README.md"),
          `# ${pkg.name}\n\nPlaceholder. The real package is published from https://github.com/${githubRepoSlug(pkg.manifest)} by trusted publishing.\n`,
        );
        if (!exec(commands.publish)) {
          console.error(`\n${pkg.name}: npm publish failed. Fix the cause and re-run; finished steps are skipped.`);
          return 1;
        }
        if (!opts.dryRun && !(await waitUntilVisible(pkg.name, opts.registry))) {
          console.error(`\n${pkg.name}: published, but still not readable on the registry. Re-run later to resume.`);
          return 1;
        }
        if (!exec(commands.trust)) {
          console.error(`\n${pkg.name}: npm trust failed. Re-run to resume; the placeholder will not be published again.`);
          return 1;
        }
      } else if (!exec(commands.trust)) {
        // Resuming an unfinished bootstrap: whether the earlier run already registered the trusted
        // publisher is not readable without another 2FA round-trip, so a failure here (typically "already
        // configured") is only a warning. release.yml's preflight probe is the authoritative check.
        console.warn(
          `${pkg.name}: npm trust failed. An E409 "configuration ... already exists" means an earlier run already registered it, which is fine; release.yml's dry-run probe confirms either way.`,
        );
      }
      // The placeholder's deprecation is cosmetic (the real release becomes `latest` anyway), so a
      // failure is reported but does not stop the remaining packages.
      if (!exec(commands.deprecate)) console.warn(`${pkg.name}: npm deprecate failed; re-run later to retry.`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (todo.length === 0) console.log("\nNothing to bootstrap.");
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(2);
    },
  );
}

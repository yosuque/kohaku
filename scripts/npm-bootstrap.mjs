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
 * Exit codes: list mode exits 1 when any package is missing (so it can gate a checklist), 0 otherwise;
 * `--publish` exits non-zero on the first failing npm command.
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

/** `true` if the registry knows the package name, `false` on 404; throws on anything else. */
export async function existsOnRegistry(name, registry) {
  const url = `${registry.replace(/\/$/, "")}/${encodeURIComponent(name).replace("%40", "@")}`;
  const res = await fetch(url, { headers: { Accept: "application/vnd.npm.install-v1+json" } });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`GET ${url} answered HTTP ${res.status}`);
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

/** The npm commands that bootstrap one package, as argv arrays (`dir` is the placeholder's directory). */
export function bootstrapCommands(manifest, dir, registry) {
  const slug = githubRepoSlug(manifest);
  const reg = ["--registry", registry];
  return [
    ["npm", "publish", dir, "--access", "public", "--tag", PLACEHOLDER_TAG, ...reg],
    [
      "npm",
      "trust",
      "github",
      manifest.name,
      "--file",
      WORKFLOW_FILE,
      "--repository",
      slug,
      "--environment",
      ENVIRONMENT,
      "--allow-publish",
      "--yes",
      ...reg,
    ],
    [
      "npm",
      "deprecate",
      `${manifest.name}@${PLACEHOLDER_VERSION}`,
      "Placeholder for the first trusted-publishing release; install a real version instead.",
      ...reg,
    ],
  ];
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
  const missing = [];
  for (const pkg of packages) {
    const exists = await existsOnRegistry(pkg.name, opts.registry);
    console.log(`${exists ? "exists " : "MISSING"}  ${pkg.name}`);
    if (!exists) missing.push(pkg);
  }

  if (!opts.publish) {
    if (missing.length > 0) {
      console.log(
        `\n${missing.length} package(s) have never been published. Bootstrap them before the release:\n  node scripts/npm-bootstrap.mjs --publish`,
      );
      return 1;
    }
    return 0;
  }

  for (const pkg of missing) {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-npm-bootstrap-"));
    try {
      writeFileSync(join(dir, "package.json"), `${JSON.stringify(placeholderManifest(pkg.manifest), null, 2)}\n`);
      writeFileSync(
        join(dir, "README.md"),
        `# ${pkg.name}\n\nPlaceholder. The real package is published from https://github.com/${githubRepoSlug(pkg.manifest)} by trusted publishing.\n`,
      );
      console.log(`\n# ${pkg.name}`);
      for (const [cmd, ...args] of bootstrapCommands(pkg.manifest, dir, opts.registry)) {
        console.log(`$ ${[cmd, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
        if (opts.dryRun) continue;
        const result = spawnSync(cmd, args, { stdio: "inherit" });
        if (result.status !== 0) {
          console.error(`\n${pkg.name}: \`${cmd} ${args[0]}\` failed (exit ${result.status ?? result.signal}).`);
          return 1;
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (missing.length === 0) console.log("\nNothing to bootstrap.");
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

#!/usr/bin/env node
/**
 * Release notes from the package CHANGELOGs.
 *
 * `changeset version` writes one `## <version>` section into every publishable package's own
 * `CHANGELOG.md` (20 packages today: `packages/*`, `cli`, `spec`). Because the fixed group moves all of
 * them together, most of those sections are identical or near-identical -- the same "Updated dependencies"
 * bump repeated 19 times, and the odd genuinely user-facing change copied verbatim into every package that
 * carries it. A GitHub Release body built by concatenating all 20 sections would be almost entirely noise.
 * This script computes the union instead: one entry per distinct change, annotated with which package(s)
 * it came from, with the pure dependency-bump noise dropped entirely. It is used by the Version workflow
 * (`.github/workflows/version.yml`) to generate the body of the draft release it creates once a version
 * pull request merges, and can be run by hand for a preview.
 *
 * Usage:
 *   node scripts/release-notes.mjs <version> [--root <dir>]
 *
 * Prints the release notes as Markdown to stdout. Exits 1 with a one-line diagnostic on stderr if no
 * publishable package's CHANGELOG has a `## <version>` section at all (nothing to report -- most likely the
 * wrong version was passed, or `changeset version` was never run for it).
 *
 * ESM, `node:fs` / `node:path` only -- no dependencies, so it can run before `pnpm install` if it ever needs
 * to.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------------------------------------
// Package discovery -- same rule as scripts/pack-smoke.mjs and spec/test/package-manifest.test.ts's
// PUBLISHED_DIRS: anything under packages/*, cli, spec whose package.json has a publishConfig and is not
// private. A package with no CHANGELOG.md (never released, or just added) simply contributes no section --
// that is not an error.
// ---------------------------------------------------------------------------------------------------------

/** Returns `[{ dir, name }]` for every publishable package under `root`, sorted by package name. */
function discoverPublishedPackages(root) {
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
    packages.push({ dir, name: manifest.name });
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return packages;
}

// ---------------------------------------------------------------------------------------------------------
// Parsing changelog-github's format (what @changesets/changelog-github writes)
// ---------------------------------------------------------------------------------------------------------

/**
 * Returns the body of the `## <version>` section (everything up to but not including the next `## `
 * heading), or `undefined` if no line is an exact match. Exact match matters: `## 0.2.0` must not match
 * `## 0.20.0`.
 */
export function extractVersionSection(text, version) {
  const lines = text.split("\n");
  const headingRe = /^## (.+?)\s*$/;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = headingRe.exec(lines[i]);
    if (match && match[1] === version) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * Parses a version section into `Map<heading, string[]>`, one entry per `### <heading>` block (changesets
 * uses "Major Changes" / "Minor Changes" / "Patch Changes"). Each array holds the raw text of every
 * top-level `- ` bullet in that block, with any following indented lines (wrapped text, or a nested
 * `  - @scope/pkg@1.2.3` list under "Updated dependencies") folded into the same bullet. Blank lines are
 * bullet/heading separators, not content.
 */
export function parseSection(section) {
  const result = new Map();
  let bulletsForHeading = null;
  let bulletLines = null;

  const flushBullet = () => {
    if (bulletLines !== null) {
      bulletsForHeading.push(bulletLines.join("\n"));
      bulletLines = null;
    }
  };

  for (const line of section.split("\n")) {
    const headingMatch = /^### +(.+?)\s*$/.exec(line);
    if (headingMatch) {
      flushBullet();
      const heading = headingMatch[1];
      if (!result.has(heading)) result.set(heading, []);
      bulletsForHeading = result.get(heading);
      continue;
    }
    if (/^- /.test(line)) {
      flushBullet();
      if (bulletsForHeading === null) continue; // a bullet before any heading -- not the changesets shape
      bulletLines = [line];
      continue;
    }
    if (line.trim() === "") continue; // separator, never part of a bullet
    if (bulletLines !== null) bulletLines.push(line); // continuation of the current bullet
  }
  flushBullet();
  return result;
}

// A changeset touching the fixed group stamps every OTHER package's bump as "Updated dependencies", either
// as its own bullet (the common case) or, defensively, as a bare "- @kohaku-ui/pkg@1.2.3" bullet should the
// tool's output ever take that shape instead.
const DEPENDENCY_NOISE_RE = /^- Updated dependencies\b/;
const DEPENDENCY_BUMP_RE = /^- \[?@kohaku-ui\/\S+@\d/;

/** True when `bullet` (as produced by parseSection) is a dependency-bump entry, not a user-facing change. */
export function isDependencyNoise(bullet) {
  const firstLine = bullet.split("\n", 1)[0];
  return DEPENDENCY_NOISE_RE.test(firstLine) || DEPENDENCY_BUMP_RE.test(firstLine);
}

// ---------------------------------------------------------------------------------------------------------
// Collecting the union across every publishable package
// ---------------------------------------------------------------------------------------------------------

const HEADING_ORDER = ["Major Changes", "Minor Changes", "Patch Changes"];

/** `git+https://github.com/owner/repo.git` (or similar) -> `https://github.com/owner/repo`. */
function normalizeRepositoryUrl(url) {
  if (!url) return undefined;
  return url
    .replace(/^git\+/, "")
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/, "");
}

/**
 * Reads every publishable package's CHANGELOG.md under `root`, extracts each one's `## <version>` section,
 * and merges the bullets into one deduplicated, ordered structure:
 *
 *   { found, version, packageNames, repositoryUrl, headings: [{ heading, bullets: [{ text, packages }] }] }
 *
 * `found` is false only when NOT ONE package has a `## <version>` section at all. Two identical packages
 * (whitespace-normalized) collapse into one bullet; the first package to contribute it wins the displayed
 * text, and every later package that repeats it is appended to that bullet's `packages` list. Dependency
 * noise (isDependencyNoise) is dropped before dedup, so it never occupies the "first occurrence". Headings
 * are ordered Major -> Minor -> Patch (only the ones actually present), then any other heading in the order
 * it was first seen.
 */
export function collectReleaseNotes({ root, version }) {
  const packages = discoverPublishedPackages(root);
  const headingBullets = new Map(); // heading -> Map<normalizedText, { text, packages: string[] }>
  const headingSeenOrder = [];
  let found = false;

  for (const pkg of packages) {
    const changelogPath = join(pkg.dir, "CHANGELOG.md");
    if (!existsSync(changelogPath)) continue;
    const section = extractVersionSection(readFileSync(changelogPath, "utf8"), version);
    if (section === undefined) continue;
    found = true;

    for (const [heading, bullets] of parseSection(section)) {
      for (const bullet of bullets) {
        if (isDependencyNoise(bullet)) continue;
        if (!headingBullets.has(heading)) {
          headingBullets.set(heading, new Map());
          headingSeenOrder.push(heading);
        }
        const byText = headingBullets.get(heading);
        const key = bullet.trim().replace(/\s+/g, " ");
        const existing = byText.get(key);
        if (existing) {
          existing.packages.push(pkg.name);
        } else {
          byText.set(key, { text: bullet, packages: [pkg.name] });
        }
      }
    }
  }

  let repositoryUrl;
  const rootManifestPath = join(root, "package.json");
  if (existsSync(rootManifestPath)) {
    const rootManifest = JSON.parse(readFileSync(rootManifestPath, "utf8"));
    repositoryUrl = normalizeRepositoryUrl(rootManifest.repository?.url);
  }

  const orderedHeadings = [
    ...HEADING_ORDER.filter((h) => headingBullets.has(h)),
    ...headingSeenOrder.filter((h) => !HEADING_ORDER.includes(h)),
  ];
  const headings = orderedHeadings.map((heading) => ({
    heading,
    bullets: [...headingBullets.get(heading).values()],
  }));

  return {
    found,
    version,
    packageNames: packages.map((p) => p.name),
    repositoryUrl,
    headings,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------------

/** Renders the structure returned by collectReleaseNotes() as Markdown. Assumes `notes.found` is true. */
export function renderReleaseNotes(notes) {
  const lines = [];

  if (notes.headings.length === 0) {
    // A version whose only changesets were dependency bumps (every package moved for the fixed group, but
    // nothing in it changed anything a consumer would notice).
    lines.push("No user-facing changes recorded in the changesets for this version.");
  } else {
    for (const { heading, bullets } of notes.headings) {
      lines.push(`### ${heading}`, "");
      for (const bullet of bullets) {
        lines.push(bullet.text);
        lines.push(`  _Packages: ${bullet.packages.join(", ")}_`);
        lines.push("");
      }
    }
  }

  const packageList = notes.packageNames.join(", ");
  lines.push(
    `All ${notes.packageNames.length} npm packages are published at ${notes.version}: \`${packageList}\``,
    `Python: \`kohaku-ui==${notes.version}\``,
  );
  if (notes.repositoryUrl) {
    lines.push(`Per-package changelogs: ${notes.repositoryUrl}/tree/v${notes.version}`);
  }

  return `${lines.join("\n").trim()}\n`;
}

// ---------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const version = argv[0];
  let root = process.cwd();
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--root") root = argv[++i];
  }
  return { version, root };
}

function main() {
  const { version, root } = parseArgs(process.argv.slice(2));
  if (!version) {
    console.error("release-notes: usage: node scripts/release-notes.mjs <version> [--root <dir>]");
    process.exit(1);
  }

  const notes = collectReleaseNotes({ root, version });
  if (!notes.found) {
    console.error(`release-notes: no publishable package's CHANGELOG.md has a "## ${version}" section`);
    process.exit(1);
  }

  process.stdout.write(renderReleaseNotes(notes));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

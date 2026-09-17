import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Black-box tests for scripts/release-notes.mjs, run the way it is actually invoked: as a child process
 * (`node scripts/release-notes.mjs <version> --root <dir>`) against a throwaway fixture tree, never by
 * importing its exported functions directly. This is deliberate -- the contract that matters is the CLI's
 * stdout/exit code, and spawning also exercises the `import.meta.url === pathToFileURL(...)` main guard
 * itself, which an in-process import would bypass entirely.
 *
 * Each fixture is a minimal stand-in for the real repo shape (`<root>/packages/<name>/package.json` +
 * `CHANGELOG.md`, `<root>/package.json` for the repository URL): just enough for discoverPublishedPackages
 * and the changelog-github parser to do their job, with the same `#PR` / commit-link / "Thanks" shape
 * @changesets/changelog-github actually writes, so a future change to that shape would show up here.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "release-notes.mjs");

const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function fixtureRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "kohaku-release-notes-"));
  tmpDirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "kohaku-monorepo-fixture",
      repository: { type: "git", url: "git+https://github.com/yosuque/kohaku.git" },
    }),
  );
  return dir;
}

interface PackageFixture {
  name: string;
  /** Directory name under packages/ (defaults to the part of `name` after the last "/"). */
  dirName?: string;
  private?: boolean;
  /** Omit publishConfig entirely to simulate a workspace-only (never published) package. */
  publishConfig?: boolean;
  changelog?: string;
}

/** Adds `packages/<dirName>/package.json` (+ CHANGELOG.md, if given) under an existing fixture root. */
function addPackage(root: string, pkg: PackageFixture): void {
  const dirName = pkg.dirName ?? pkg.name.split("/").pop()!;
  const dir = join(root, "packages", dirName);
  mkdirSync(dir, { recursive: true });
  const manifest: Record<string, unknown> = { name: pkg.name };
  if (pkg.private) manifest.private = true;
  if (pkg.publishConfig !== false) manifest.publishConfig = { access: "public" };
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  if (pkg.changelog !== undefined) {
    writeFileSync(join(dir, "CHANGELOG.md"), pkg.changelog);
  }
}

function runReleaseNotes(root: string, version: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [SCRIPT, version, "--root", root], { encoding: "utf8" });
}

describe("release-notes.mjs", () => {
  it("collapses a bullet shared by three packages into one entry, crediting all three", () => {
    const root = fixtureRoot();
    const shared = [
      "### Minor Changes",
      "",
      "- [#42](https://github.com/yosuque/kohaku/pull/42) [`1a2b3c4`](https://github.com/yosuque/kohaku/commit/1a2b3c4) Thanks [@yosuque](https://github.com/yosuque)! - Add a new widget.",
      "",
    ].join("\n");
    for (const name of ["aaa", "bbb", "ccc"]) {
      addPackage(root, {
        name: `@kohaku-ui/${name}`,
        changelog: `# @kohaku-ui/${name}\n\n## 0.2.0\n\n${shared}`,
      });
    }

    const result = runReleaseNotes(root, "0.2.0");
    expect(result.status).toBe(0);
    const bulletOccurrences = result.stdout.match(/Add a new widget\./g) ?? [];
    expect(bulletOccurrences).toHaveLength(1);
    expect(result.stdout).toContain("_Packages: @kohaku-ui/aaa, @kohaku-ui/bbb, @kohaku-ui/ccc_");
  });

  it("drops 'Updated dependencies' bullets and their nested package-bump lines", () => {
    const root = fixtureRoot();
    addPackage(root, {
      name: "@kohaku-ui/aaa",
      changelog: [
        "# @kohaku-ui/aaa",
        "",
        "## 0.2.0",
        "",
        "### Patch Changes",
        "",
        "- Updated dependencies [7d6a878]",
        "  - @kohaku-ui/bbb@0.2.0",
        "  - @kohaku-ui/ccc@0.2.0",
        "",
      ].join("\n"),
    });

    const result = runReleaseNotes(root, "0.2.0");
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("Updated dependencies");
    expect(result.stdout).not.toContain("@kohaku-ui/bbb@0.2.0");
    expect(result.stdout).not.toContain("@kohaku-ui/ccc@0.2.0");
    // Nothing user-facing is left over for this version.
    expect(result.stdout).toContain("No user-facing changes recorded in the changesets for this version.");
  });

  it("keeps a multi-line bullet's wrapped continuation text intact", () => {
    const root = fixtureRoot();
    addPackage(root, {
      name: "@kohaku-ui/aaa",
      changelog: [
        "# @kohaku-ui/aaa",
        "",
        "## 0.2.0",
        "",
        "### Minor Changes",
        "",
        "- [#42](https://github.com/yosuque/kohaku/pull/42) [`1a2b3c4`](https://github.com/yosuque/kohaku/commit/1a2b3c4) Thanks [@yosuque](https://github.com/yosuque)! - Add a widget",
        "  that spans two lines of description.",
        "",
      ].join("\n"),
    });

    const result = runReleaseNotes(root, "0.2.0");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Add a widget\n  that spans two lines of description.");
  });

  it("orders headings Major, then Minor, then Patch", () => {
    const root = fixtureRoot();
    addPackage(root, {
      name: "@kohaku-ui/aaa",
      changelog: [
        "# @kohaku-ui/aaa",
        "",
        "## 0.2.0",
        "",
        "### Patch Changes",
        "",
        "- A patch-level bullet.",
        "",
        "### Major Changes",
        "",
        "- A breaking change.",
        "",
        "### Minor Changes",
        "",
        "- A minor feature.",
        "",
      ].join("\n"),
    });

    const result = runReleaseNotes(root, "0.2.0");
    expect(result.status).toBe(0);
    const majorIdx = result.stdout.indexOf("### Major Changes");
    const minorIdx = result.stdout.indexOf("### Minor Changes");
    const patchIdx = result.stdout.indexOf("### Patch Changes");
    expect(majorIdx).toBeGreaterThanOrEqual(0);
    expect(majorIdx).toBeLessThan(minorIdx);
    expect(minorIdx).toBeLessThan(patchIdx);
  });

  it("does not leak an older version's section, and does not treat 0.20.0 as a match for 0.2.0", () => {
    const root = fixtureRoot();
    addPackage(root, {
      name: "@kohaku-ui/aaa",
      changelog: [
        "# @kohaku-ui/aaa",
        "",
        "## 0.2.0",
        "",
        "### Minor Changes",
        "",
        "- The real 0.2.0 change.",
        "",
        "## 0.20.0",
        "",
        "### Minor Changes",
        "",
        "- A change that belongs to 0.20.0, not 0.2.0.",
        "",
        "## 0.1.0",
        "",
        "### Minor Changes",
        "",
        "- An old 0.1.0 change that must not leak forward.",
        "",
      ].join("\n"),
    });

    const result = runReleaseNotes(root, "0.2.0");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("The real 0.2.0 change.");
    expect(result.stdout).not.toContain("0.20.0, not 0.2.0");
    expect(result.stdout).not.toContain("old 0.1.0 change");
  });

  it("ignores a package with no publishConfig and a published package with no CHANGELOG", () => {
    const root = fixtureRoot();
    addPackage(root, {
      name: "@kohaku-ui/workspace-only",
      publishConfig: false,
      changelog: "# @kohaku-ui/workspace-only\n\n## 0.2.0\n\n### Minor Changes\n\n- Must never appear.\n",
    });
    addPackage(root, { name: "@kohaku-ui/no-changelog" }); // published, but CHANGELOG.md does not exist
    addPackage(root, {
      name: "@kohaku-ui/aaa",
      changelog: "# @kohaku-ui/aaa\n\n## 0.2.0\n\n### Minor Changes\n\n- A real change.\n",
    });

    const result = runReleaseNotes(root, "0.2.0");
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("Must never appear.");
    expect(result.stdout).toContain("A real change.");
    // The workspace-only package must not even count toward the footer's package list.
    expect(result.stdout).not.toContain("@kohaku-ui/workspace-only");
    // The CHANGELOG-less published package still counts as published.
    expect(result.stdout).toContain("@kohaku-ui/no-changelog");
  });

  it("footer lists every published package name, in name order, plus the PyPI line and changelog link", () => {
    const root = fixtureRoot();
    for (const name of ["zzz", "aaa", "mmm"]) {
      addPackage(root, {
        name: `@kohaku-ui/${name}`,
        changelog: `# @kohaku-ui/${name}\n\n## 0.2.0\n\n### Minor Changes\n\n- A change in ${name}.\n`,
      });
    }

    const result = runReleaseNotes(root, "0.2.0");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "All 3 npm packages are published at 0.2.0: `@kohaku-ui/aaa, @kohaku-ui/mmm, @kohaku-ui/zzz`",
    );
    expect(result.stdout).toContain("Python: `kohaku-ui==0.2.0`");
    expect(result.stdout).toContain("Per-package changelogs: https://github.com/yosuque/kohaku/tree/v0.2.0");
  });

  it("exits 1 with the requested version named in the diagnostic when no CHANGELOG has that section", () => {
    const root = fixtureRoot();
    addPackage(root, {
      name: "@kohaku-ui/aaa",
      changelog: "# @kohaku-ui/aaa\n\n## 0.1.0\n\n### Minor Changes\n\n- Some 0.1.0 change.\n",
    });

    const result = runReleaseNotes(root, "9.9.9");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("9.9.9");
  });

  it("exits 0 with a 'no user-facing changes' message for a dependency-only version", () => {
    const root = fixtureRoot();
    addPackage(root, {
      name: "@kohaku-ui/aaa",
      changelog: [
        "# @kohaku-ui/aaa",
        "",
        "## 0.3.0",
        "",
        "### Patch Changes",
        "",
        "- Updated dependencies [abc1234]",
        "  - @kohaku-ui/spec-core@0.3.0",
        "",
      ].join("\n"),
    });

    const result = runReleaseNotes(root, "0.3.0");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No user-facing changes recorded in the changesets for this version.");
  });
});

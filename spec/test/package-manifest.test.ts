import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the publishing contract of the workspace manifests, the way dependency-direction.test.ts guards
 * the layering. Nothing here is checked by any other test: the manifests only matter once a tarball is
 * built, so a mistake would otherwise surface as a broken published package.
 *
 * The invariants, and why each one exists:
 *
 *  - `exports` keeps pointing at `src/*.ts` and `publishConfig.exports` at `dist`. The workspace resolves
 *    TypeScript directly; pnpm overlays publishConfig when it packs. If the two key sets ever diverge, a
 *    subpath ships pointing at a file that is not in the tarball -- an error nothing local would catch.
 *  - No `peerDependencies` entry may resolve to an exact version. pnpm rewrites `catalog:` to the
 *    catalog's own specifier at publish time, and some catalog entries are exact pins (react is, so the
 *    workspace resolves a single copy). Published verbatim, that demands an exact version from every
 *    consumer.
 *  - `apps/*` stay private: they are demonstrations, not library code.
 *
 * Run `pnpm meta:sync` to regenerate the derived fields; CI fails on the resulting diff.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Manifest {
  name: string;
  private?: boolean;
  license?: string;
  description?: string;
  engines?: Record<string, string>;
  files?: string[];
  exports?: Record<string, string>;
  repository?: { directory?: string };
  peerDependencies?: Record<string, string>;
  publishConfig?: {
    access?: string;
    exports?: Record<string, unknown>;
  };
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8")) as Manifest;
}

/**
 * Must stay in step with PUBLISHED_DIRS in scripts/sync-package-meta.ts: every workspace package
 * directory, minus any that is explicitly `private` (e.g. @kohaku-ui/port-contracts, a test-only
 * suite package never meant to ship). Derived rather than hand-listed a second time, so a new
 * private package under packages/ does not have to be excluded here by hand.
 */
const PUBLISHED_DIRS = [
  ...readdirSync(join(REPO_ROOT, "packages"))
    .map((name) => `packages/${name}`)
    .filter((dir) => readManifest(dir).private !== true),
  "cli",
  "spec",
];

/** The catalog's own specifier for a dependency name, or undefined when it has no catalog entry. */
function catalogSpecifier(name: string): string | undefined {
  const yaml = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
  const line = yaml
    .split("\n")
    .find((l) => new RegExp(`^\\s{2}"?${name.replace(/[/@.]/g, "\\$&")}"?:`).test(l));
  return line?.split(":").slice(1).join(":").trim().replace(/^"|"$/g, "");
}

/** True when a specifier pins one exact version (no range operator). */
function isExactPin(specifier: string): boolean {
  return /^\d+\.\d+\.\d+/.test(specifier);
}

describe("publishable package manifests", () => {
  const published = PUBLISHED_DIRS.map((dir) => [dir, readManifest(dir)] as const);

  it("every published package carries the publishing metadata", () => {
    for (const [dir, manifest] of published) {
      expect(manifest.private, `${manifest.name} must not be private`).toBeUndefined();
      expect(manifest.license, `${manifest.name} license`).toBe("Apache-2.0");
      expect(manifest.description, `${manifest.name} description`).toBeTruthy();
      expect(manifest.repository?.directory, `${manifest.name} repository.directory`).toBe(dir);
      expect(manifest.engines?.["node"], `${manifest.name} engines.node`).toBe(">=22");
      expect(manifest.files, `${manifest.name} files`).toContain("dist");
      expect(manifest.publishConfig?.access, `${manifest.name} publishConfig.access`).toBe("public");
    }
  });

  it("publishConfig.exports covers exactly the development exports", () => {
    for (const [, manifest] of published) {
      const devKeys = Object.keys(manifest.exports ?? {}).sort();
      const publishedKeys = Object.keys(manifest.publishConfig?.exports ?? {})
        .filter((key) => key !== "./package.json")
        .sort();
      expect(publishedKeys, `${manifest.name} publishConfig.exports keys`).toEqual(devKeys);
    }
  });

  it("every published export entry points into dist", () => {
    for (const [, manifest] of published) {
      for (const [key, value] of Object.entries(manifest.publishConfig?.exports ?? {})) {
        if (key === "./package.json") continue;
        if (typeof value === "string") {
          // JSON assets are shipped verbatim rather than compiled.
          expect(value, `${manifest.name} ${key}`).toMatch(/\.json$/);
          continue;
        }
        const entry = value as { types?: string; default?: string };
        expect(entry.types, `${manifest.name} ${key} types`).toMatch(/^\.\/dist\/.+\.d\.ts$/);
        expect(entry.default, `${manifest.name} ${key} default`).toMatch(/^\.\/dist\/.+\.js$/);
      }
    }
  });

  it("no peerDependency resolves to an exact version", () => {
    for (const [, manifest] of published) {
      for (const [name, specifier] of Object.entries(manifest.peerDependencies ?? {})) {
        const effective = specifier === "catalog:" ? catalogSpecifier(name) : specifier;
        expect(effective, `${manifest.name} peer ${name} has no catalog entry`).toBeDefined();
        expect(
          isExactPin(effective as string),
          `${manifest.name} peer ${name} would publish as the exact version "${effective}"`,
        ).toBe(false);
      }
    }
  });

  it("the sample apps stay private", () => {
    for (const name of readdirSync(join(REPO_ROOT, "apps"))) {
      const manifest = readManifest(`apps/${name}`);
      expect(manifest.private, `apps/${name} must stay private`).toBe(true);
    }
  });
});

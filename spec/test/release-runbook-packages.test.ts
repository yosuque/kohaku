import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards docs/runbooks/release.md's trusted-publisher checklist (§2) against drift from the actual set
 * of publishable packages. This is the failure mode the review caught: two packages
 * (@kohaku-ui/admin-react, @kohaku-ui/semantic-llm) were added without updating the release docs, so the
 * runbook silently under-counted the packages a release actually needs a registered npm trusted
 * publisher for -- a real release blocker, not just stale prose. See also package-manifest.test.ts,
 * which guards the manifests themselves; this test guards the one hand-maintained document that
 * transcribes their names.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCOPE = "@kohaku-ui/";

/** Must stay in step with PUBLISHED_DIRS in package-manifest.test.ts / scripts/sync-package-meta.ts. */
const PRIVATE_PACKAGE_DIRS = ["packages/port-contracts"];

function derivePublishablePackageNames(): string[] {
  const dirs = [
    ...readdirSync(join(REPO_ROOT, "packages"))
      .map((name) => `packages/${name}`)
      .filter((dir) => !PRIVATE_PACKAGE_DIRS.includes(dir)),
    "cli",
    "spec",
  ];
  return dirs
    .map((dir) => JSON.parse(readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8")) as { name: string })
    .map((manifest) => manifest.name.replace(SCOPE, ""))
    .sort();
}

/**
 * Pulls the "Packages: ..." / "対象パッケージ: ..." sentence out of the runbook (stops at the first
 * ASCII or full-width period, since neither language's package list contains one).
 */
function extractRunbookPackageList(runbookText: string): string[] {
  const match = runbookText.match(/(?:Packages:|対象パッケージ:)\s*([\s\S]*?)[.。]\s/);
  if (!match) throw new Error("release.md: could not find the package list sentence in §2");
  const codeSpans = [...match[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  return codeSpans.map((name) => name.replace(SCOPE, "")).sort();
}

/** Pulls the stated package count out of "for each of the N packages below" / "以下の N パッケージそれぞれ". */
function extractRunbookPackageCount(runbookText: string): number {
  const match = runbookText.match(/for each of the (\d+) packages below|以下の (\d+) パッケージそれぞれ/);
  if (!match) throw new Error("release.md: could not find the stated package count in §2");
  return Number(match[1] ?? match[2]);
}

describe("docs/runbooks/release.md tracks the actual publishable package set", () => {
  const derived = derivePublishablePackageNames();

  for (const [label, path] of [
    ["English", "docs/runbooks/release.md"],
    ["Japanese", "docs/runbooks/release.ja.md"],
  ] as const) {
    describe(label, () => {
      const text = readFileSync(join(REPO_ROOT, path), "utf8");

      it("lists every publishable package in the trusted-publisher checklist", () => {
        const listed = extractRunbookPackageList(text);
        const missing = derived.filter((name) => !listed.includes(name));
        const extra = listed.filter((name) => !derived.includes(name));
        expect(missing, `packages missing from ${path}'s trusted-publisher list`).toEqual([]);
        expect(
          extra,
          `${path}'s trusted-publisher list names packages that no longer exist / are private`,
        ).toEqual([]);
      });

      it("states the correct package count", () => {
        expect(extractRunbookPackageCount(text), `${path}'s stated package count`).toBe(derived.length);
      });
    });
  }
});

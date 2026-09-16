import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REQUIREMENTS } from "../conformance/index.js";

/**
 * Structural checks on conformance/manifest.ts, independent of the black-box / self-check suites
 * exercised by conformance.test.ts: the manifest is internally consistent (no duplicate ids, every
 * "reference" requirement is actually backed by a verifiedBy path that exists), and its id set agrees
 * with what SPEC.md itself documents (in both directions -- a requirement dropped from one side without
 * the other, or a typo in either, silently breaks the "SPEC.md and the manifest are paired" premise
 * documented at the top of manifest.ts).
 *
 * Deliberately out of scope here: whether SPEC.md / docs/specification.md / docs/design.md /
 * python/README.md's stated MUST *counts* match REQUIREMENTS's actual MUST count. That needs a docs pass
 * to correct the numbers first (see this file's own history / the WP that added this test for the
 * numbers this manifest yields as of this writing).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC_MD = readFileSync(join(REPO_ROOT, "spec", "SPEC.md"), "utf8");

// Mirrors AGENTS.md / the plan's own description of the requirement-id shape: <PREFIX>-<CODE>-<3 digits>.
const REQUIREMENT_ID_PATTERN = /\b(SPEC|REST|CMP|MCPAPP|SBX|LIN)-[A-Z0-9]+-\d{3}\b/g;

describe("conformance manifest metadata", () => {
  it("has no duplicate requirement ids", () => {
    const ids = REQUIREMENTS.map((r) => r.id);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect([...new Set(duplicates)]).toEqual([]);
  });

  it("every verifiedBy path (comma-separated) exists in the repo", () => {
    const missing: string[] = [];
    for (const req of REQUIREMENTS) {
      if (req.verifiedBy == null) continue;
      for (const rawPath of req.verifiedBy.split(",")) {
        const relPath = rawPath.trim();
        if (!existsSync(join(REPO_ROOT, relPath))) {
          missing.push(`${req.id}: "${relPath}"`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('every "reference"-verification requirement declares a verifiedBy', () => {
    const missing = REQUIREMENTS.filter((r) => r.verification === "reference" && r.verifiedBy == null).map(
      (r) => r.id,
    );
    expect(missing).toEqual([]);
  });

  it('every "blackbox"-verification requirement declares no verifiedBy (reference-only field)', () => {
    // verifiedBy exists specifically to point at the reference-implementation test that stands in for a
    // black-box check; a blackbox requirement is already checked by the suite itself, so a verifiedBy on
    // one would be dead metadata nobody reads.
    const unexpected = REQUIREMENTS.filter((r) => r.verification === "blackbox" && r.verifiedBy != null).map(
      (r) => r.id,
    );
    expect(unexpected).toEqual([]);
  });

  it("SPEC.md's requirement-id mentions and the manifest's id set agree in both directions", () => {
    const specIds = new Set([...SPEC_MD.matchAll(REQUIREMENT_ID_PATTERN)].map((m) => m[0]));
    const manifestIds = new Set(REQUIREMENTS.map((r) => r.id));

    const inSpecNotManifest = [...specIds].filter((id) => !manifestIds.has(id)).sort();
    const inManifestNotSpec = [...manifestIds].filter((id) => !specIds.has(id)).sort();

    expect(inSpecNotManifest, "requirement ids mentioned in SPEC.md but missing from the manifest").toEqual(
      [],
    );
    expect(inManifestNotSpec, "requirement ids in the manifest but never mentioned in SPEC.md").toEqual([]);
  });
});

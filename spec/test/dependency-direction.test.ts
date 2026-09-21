import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the package dependency direction documented in the repository's AGENTS.md ("Layout essentials"):
 *
 *   spec-core -> {registry, data-binding} -> intents -> {composer, renderer-core} -> host-core
 *     -> {renderer-react, renderer-wc, sandbox, lineage, evals, host-rest, host-mcp-apps, client, otel, admin-react} -> apps
 *
 * with `llm` and `host-a2ui` documented as independent leaves (llm depends on nothing in the workspace;
 * host-a2ui only on spec-core). `otel` sits in the same layer as host-rest/host-mcp-apps/etc but (unlike
 * them) depends only on composer, not host-core.
 *
 * The top-level bullet groups sandbox and renderer-wc into the same final layer, but AGENTS.md's own more
 * detailed text says renderer-wc "reuses sandbox (mountSandbox) by importing it directly" -- i.e. sandbox
 * must sit strictly below renderer-wc, not beside it. This test resolves that by splitting the final group
 * into two sub-layers (sandbox/lineage/evals/host-rest/host-mcp-apps/client, then renderer-react/renderer-wc),
 * which matches every dependency actually declared in packages/*\/package.json. If a future change to the
 * package graph contradicts this ordering, the failure message below names the offending edge and the
 * expected layer so it can be triaged (either the code or the documented order is wrong).
 */

// Ordered from the root of the dependency graph outward. Each package must depend (via "dependencies",
// not "devDependencies") only on packages in a strictly earlier layer.
const LAYERS: string[][] = [
  ["spec-core", "llm"],
  ["registry", "data-binding", "host-a2ui"],
  ["intents"],
  ["composer", "renderer-core"],
  ["host-core"],
  ["sandbox", "lineage", "evals", "host-rest", "host-mcp-apps", "client", "otel"],
  ["renderer-react", "renderer-wc", "admin-react"],
];

const SCOPE = "@kohaku-ui/";

function layerIndexOf(name: string): number {
  return LAYERS.findIndex((layer) => layer.includes(name));
}

interface PackageInfo {
  name: string;
  dependencies: string[];
}

function readPackages(packagesDir: string): PackageInfo[] {
  const dirs = readdirSync(packagesDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  const packages: PackageInfo[] = [];
  for (const dir of dirs) {
    const pkgPath = join(packagesDir, dir.name, "package.json");
    let raw: string;
    try {
      raw = readFileSync(pkgPath, "utf8");
    } catch {
      continue; // not every workspace directory is guaranteed to have a package.json
    }
    const pkg = JSON.parse(raw) as { name: string; dependencies?: Record<string, string> };
    const dependencies = Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith(SCOPE));
    packages.push({ name: pkg.name, dependencies });
  }
  return packages;
}

describe("package dependency direction (AGENTS.md 'Layout essentials')", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..");
  const packages = readPackages(join(repoRoot, "packages"));

  it("every documented package appears in the layer graph exactly once", () => {
    const seen = new Set<string>();
    for (const layer of LAYERS) {
      for (const name of layer) {
        expect(seen.has(name), `"${name}" appears in more than one layer`).toBe(false);
        seen.add(name);
      }
    }
    const missing = packages.map((p) => p.name.replace(SCOPE, "")).filter((short) => !seen.has(short));
    expect(missing, `packages missing from the LAYERS graph: ${missing.join(", ")}`).toEqual([]);
  });

  it("every @kohaku-ui/* dependency points to a strictly lower layer than its consumer", () => {
    const violations: string[] = [];
    for (const pkg of packages) {
      const consumerShort = pkg.name.replace(SCOPE, "");
      const consumerLayer = layerIndexOf(consumerShort);
      if (consumerLayer === -1) {
        violations.push(`"${pkg.name}" is not declared in the LAYERS graph`);
        continue;
      }
      for (const dep of pkg.dependencies) {
        const depShort = dep.replace(SCOPE, "");
        const depLayer = layerIndexOf(depShort);
        if (depLayer === -1) {
          violations.push(`"${pkg.name}" depends on "${dep}", which is not declared in the LAYERS graph`);
          continue;
        }
        if (depLayer >= consumerLayer) {
          violations.push(
            `"${pkg.name}" (layer ${consumerLayer}) depends on "${dep}" (layer ${depLayer}), which is ` +
              `not strictly lower -- this contradicts the documented dependency direction in AGENTS.md`,
          );
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

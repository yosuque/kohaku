import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as portsFixture from "../snippets/kohaku/ports.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * apps/docs-site/snippets/kohaku/ports.ts is a hand-written fixture for the fuller governance demo
 * (full-stack.ts), which wires all four Ports directly (no createKohakuHost) so it can also plug in
 * lineage / promotions / fixations. (docs/paths/mcp-apps.md's first code block, minimal-host.ts, needs
 * only `domainPort` via createKohakuHost.) Since `@kohaku-ui/host`'s createKohakuHost() (design.md #52) supplies working defaults for
 * authz / storage / the SemanticPort, `kohaku scaffold ports`'s own PORTS_TEMPLATE (cli/src/templates.ts)
 * now scaffolds only a DomainPort — a strict subset of what this fixture exports, not an exact match any
 * more. The adoption-path pages still credit that command for `domainPort` specifically, so this guards
 * that every name PORTS_TEMPLATE emits is still present here — otherwise a reader who runs the documented
 * command and pastes the documented snippet gets "has no exported member" errors on the first file they
 * touch (I-3). It does not require the reverse (the fixture may export more than the CLI scaffolds, e.g.
 * `authzPort` / `semanticPort` / `storagePort`).
 *
 * This is read as plain text, not imported as a module: `cli` is not a package.json dependency of
 * docs-site (nor is it in the repo's spec-core → … → apps dependency chain in AGENTS.md), so importing
 * cli/src/templates.ts here would create an undeclared, unenforced cross-package edge. Reading its source
 * as a string and parsing the names it emits keeps this a documentation-content check, not a code
 * dependency, while still deriving the expectation from the CLI's real source rather than a hard-coded
 * list — it keeps holding when the CLI template changes.
 */
function portsTemplateExportNames(): string[] {
  const source = readFileSync(join(REPO_ROOT, "cli/src/templates.ts"), "utf8");
  const templateMatch = source.match(/export const PORTS_TEMPLATE = `([\s\S]*?)\n`;/);
  if (templateMatch == null) throw new Error("PORTS_TEMPLATE not found in cli/src/templates.ts");
  const template = templateMatch[1] ?? "";
  return [...template.matchAll(/^export const (\w+): \w+Port = \{/gm)].map((m) => m[1] ?? "");
}

describe("snippets/kohaku/ports.ts fixture covers the CLI's scaffold ports template", () => {
  it("exports at least every name PORTS_TEMPLATE (cli/src/templates.ts) emits", () => {
    const expected = portsTemplateExportNames();
    const actual = new Set(Object.keys(portsFixture));
    expect(expected.length).toBeGreaterThan(0); // guards against the regex silently matching nothing
    const missing = expected.filter((name) => !actual.has(name));
    expect(missing, `snippets/kohaku/ports.ts is missing: ${missing.join(", ")}`).toEqual([]);
  });
});

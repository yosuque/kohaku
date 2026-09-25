import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as portsFixture from "../snippets/kohaku/ports.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * apps/docs-site/snippets/kohaku/ports.ts is a hand-written fixture standing in for the file
 * `npx @kohaku-ui/cli scaffold ports` actually generates. The adoption-path pages credit that command for
 * it (a trailing "(kohaku scaffold ports)" comment on the import), so the fixture's exported names must
 * match what the CLI's own template emits — otherwise a reader who runs the documented command and pastes
 * the documented snippet gets "has no exported member" errors on the first file they touch (I-3).
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

describe("snippets/kohaku/ports.ts fixture matches the CLI's scaffold ports template", () => {
  it("exports exactly the names PORTS_TEMPLATE (cli/src/templates.ts) emits", () => {
    const expected = portsTemplateExportNames().sort();
    const actual = Object.keys(portsFixture).sort();
    expect(expected.length).toBeGreaterThan(0); // guards against the regex silently matching nothing
    expect(actual).toEqual(expected);
  });
});

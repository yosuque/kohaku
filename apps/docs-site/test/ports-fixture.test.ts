import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as intentsFixture from "../snippets/kohaku/intents.js";
import * as portsFixture from "../snippets/kohaku/ports.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * apps/docs-site/snippets/kohaku/ports.ts and intents.ts stand in for the files `kohaku scaffold ports`
 * writes (cli/src/templates.ts's PORTS_TEMPLATE and INTENTS_TEMPLATE) that the adoption-path snippets
 * import (`domainPort` from ./kohaku/ports.js, `intents` from ./kohaku/intents.js). createKohakuHost()
 * (design.md #52) supplies the other three Ports, so the scaffold no longer emits them — and the fixtures
 * must not export them either, or a page could typecheck here against a name a reader who ran the documented
 * command never gets (the path (c) page once imported `authzPort` / `storagePort` from this fixture while
 * the scaffold wrote only `domainPort`). Both directions are therefore pinned: the fixture exports exactly
 * the names the template emits.
 *
 * The templates are read as plain text, not imported as a module: `cli` is not a package.json dependency of
 * docs-site (nor is it in the repo's spec-core → … → apps dependency chain in AGENTS.md), so importing
 * cli/src/templates.ts here would create an undeclared, unenforced cross-package edge. Reading its source
 * as a string and parsing the names it emits keeps this a documentation-content check, not a code
 * dependency, while still deriving the expectation from the CLI's real source rather than a hard-coded
 * list — it keeps holding when the CLI template changes.
 */
function templateExportNames(templateConst: string): string[] {
  const source = readFileSync(join(REPO_ROOT, "cli/src/templates.ts"), "utf8");
  const templateMatch = source.match(new RegExp(`export const ${templateConst} = \`([\\s\\S]*?)\\n\`;`));
  if (templateMatch == null) throw new Error(`${templateConst} not found in cli/src/templates.ts`);
  const template = templateMatch[1] ?? "";
  return [...template.matchAll(/^export const (\w+)\b/gm)].map((m) => m[1] ?? "").sort();
}

describe.each([
  { fixture: "snippets/kohaku/ports.ts", template: "PORTS_TEMPLATE", exports: portsFixture },
  { fixture: "snippets/kohaku/intents.ts", template: "INTENTS_TEMPLATE", exports: intentsFixture },
])("$fixture mirrors the CLI's $template", ({ fixture, template, exports }) => {
  it("exports exactly the names the template emits", () => {
    const expected = templateExportNames(template);
    expect(expected.length).toBeGreaterThan(0); // guards against the regex silently matching nothing
    expect(Object.keys(exports).sort(), `${fixture} must export what ${template} emits`).toEqual(expected);
  });
});

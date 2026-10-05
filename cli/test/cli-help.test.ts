import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "../bin/kohaku.js");

describe("kohaku --help", () => {
  it("lists every subcommand and exits 0", () => {
    const result = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    for (const name of [
      "conformance",
      "explain",
      "scaffold",
      "init",
      "smoke-l2",
      "component",
      "dataset",
      "evidence",
      "migrate",
    ]) {
      expect(result.stdout).toContain(name);
    }
  }, 30_000);

  it("`init --help` exits 0", () => {
    const result = spawnSync(process.execPath, [bin, "init", "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--from <file>");
  }, 30_000);
});

/**
 * Specifiers of every top-level statement that survives type erasure and loads a module at startup: a
 * value import, an inline `import { type X }` (NOT erased under verbatimModuleSyntax: it becomes a side-effect
 * import), a side-effect `import "x"`, and a non-type `export ... from`. `import type` / `export type ... from`
 * are erased at build time and are ignored. Dynamic `await import("x")` is indented inside an action, so the
 * line-anchored patterns never see it.
 */
function startupModuleSpecifiers(source: string): string[] {
  const statements = [
    ...source.matchAll(/^import\s+(?!type\b)[^;]*?"([^"]+)"\s*;/gms),
    ...source.matchAll(/^export\s+(?!type\b)[^;]*?\bfrom\s+"([^"]+)"\s*;/gms),
  ];
  return statements.map((m) => m[1] as string);
}

describe("startupModuleSpecifiers (the scanner behind the import regression test)", () => {
  it("finds value, inline-type, side-effect and re-export specifiers and skips type-only forms", () => {
    const found = startupModuleSpecifiers(
      [
        'import { a } from "./a.js";',
        'import b from "@kohaku-ui/b";',
        'import { type C, d } from "./c.js";',
        'import { type E } from "./e.js";',
        'import "./side-effect.js";',
        'import * as f from "node:fs";',
        'export { g } from "./g.js";',
        'export * from "./h.js";',
        'import type { I } from "./i.js";',
        'export type { J } from "./j.js";',
        "import {",
        "  k,",
        '} from "./k.js";',
        '  const x = await import("./dynamic.js");',
      ].join("\n"),
    );
    expect(found).toEqual([
      "./a.js",
      "@kohaku-ui/b",
      "./c.js",
      "./e.js",
      "./side-effect.js",
      "node:fs",
      "./k.js",
      "./g.js",
      "./h.js",
    ]);
  });
});

describe("cli/src/index.ts imports", () => {
  // `--help` must not load the heavy workspace packages (client, composer, evals, sandbox, lineage, host-core...),
  // so that a partial install still prints help. Each action loads its own module with a static-string dynamic
  // import; anything else loaded at startup would pull it back into the help path. The allowlist below is the
  // whole set of modules `index.ts` may load statically.
  const source = readFileSync(join(here, "../src/index.ts"), "utf8");
  const lazyModules = ["./commands.js", "./evidence/index.js", "./migrate.js", "./init/index.js"];
  const allowedStartup = (specifier: string): boolean =>
    specifier === "commander" || specifier === "./version.js" || specifier.startsWith("node:");

  it("loads nothing at startup except commander, node:* and ./version.js", () => {
    const startup = startupModuleSpecifiers(source);
    expect(startup).toEqual(expect.arrayContaining(["commander", "./version.js"]));
    expect(startup.filter((specifier) => !allowedStartup(specifier))).toEqual([]);
  });

  it("does not load a heavy command module or a workspace package at startup", () => {
    const startup = startupModuleSpecifiers(source);
    for (const mod of lazyModules) {
      expect(startup).not.toContain(mod);
    }
    expect(startup.filter((specifier) => specifier.startsWith("@kohaku-ui/"))).toEqual([]);
  });

  it("loads each heavy command module through a dynamic import", () => {
    for (const mod of lazyModules) {
      expect(source).toContain(`await import("${mod}")`);
    }
  });
});

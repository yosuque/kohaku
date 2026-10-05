import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
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
      "usage",
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

describe("the startup graph of cli/src/index.ts", () => {
  // `--help` must not load the heavy workspace packages (client, composer, evals, sandbox, lineage, host-core...),
  // so that a partial install still prints help. The command wiring lives in one registration module per command
  // under `src/cli/`, all of which `index.ts` loads statically. Each action loads its own runner with a
  // static-string dynamic import; anything else loaded at startup would pull it back into the help path. The
  // startup graph is `index.ts` plus every module under `src/cli/` it loads statically, transitively, and the
  // allowlist below is the whole set of modules that graph may load.
  const srcDir = join(here, "../src");
  const cliDir = join(srcDir, "cli");
  const indexFile = join(srcDir, "index.ts");
  const lazyModules = [
    "commands.js",
    "evidence/index.js",
    "migrate.js",
    "init/index.js",
    "usage/index.js",
  ].map((mod) => join(srcDir, mod.replace(/\.js$/, ".ts")));

  /** Resolves a relative specifier of `file` to the on-disk TypeScript source it names. */
  const toSource = (file: string, specifier: string): string =>
    resolve(dirname(file), specifier).replace(/\.js$/, ".ts");
  const isRelative = (specifier: string): boolean => specifier.startsWith(".");
  const isCliModule = (path: string): boolean => path.startsWith(`${cliDir}${sep}`);

  interface GraphFile {
    file: string;
    source: string;
    startup: string[];
  }

  function startupGraph(): GraphFile[] {
    const seen = new Map<string, GraphFile>();
    const queue = [indexFile];
    for (let file = queue.shift(); file != null; file = queue.shift()) {
      if (seen.has(file)) continue;
      const source = readFileSync(file, "utf8");
      const startup = startupModuleSpecifiers(source);
      seen.set(file, { file, source, startup });
      for (const specifier of startup) {
        if (isRelative(specifier) && isCliModule(toSource(file, specifier))) {
          queue.push(toSource(file, specifier));
        }
      }
    }
    return [...seen.values()];
  }

  const graph = startupGraph();
  const allowedStartup = (file: string, specifier: string): boolean =>
    specifier === "commander" ||
    specifier.startsWith("node:") ||
    (file === indexFile && specifier === "./version.js") ||
    (isRelative(specifier) && isCliModule(toSource(file, specifier)));

  it("loads nothing at startup except commander, node:*, ./version.js and the modules under src/cli/", () => {
    const entry = graph.find((g) => g.file === indexFile);
    expect(entry?.startup).toEqual(expect.arrayContaining(["commander", "./version.js"]));
    for (const { file, startup } of graph) {
      expect(startup.filter((specifier) => !allowedStartup(file, specifier))).toEqual([]);
    }
  });

  it("registers every module under src/cli/ from the startup graph", () => {
    const onDisk = readdirSync(cliDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join(cliDir, name))
      .sort();
    expect(
      graph
        .map((g) => g.file)
        .filter(isCliModule)
        .sort(),
    ).toEqual(onDisk);
  });

  it("does not load a heavy command module or a workspace package at startup", () => {
    for (const { file, startup } of graph) {
      const targets = startup.filter(isRelative).map((specifier) => toSource(file, specifier));
      for (const mod of lazyModules) {
        expect(targets).not.toContain(mod);
      }
      expect(startup.filter((specifier) => specifier.startsWith("@kohaku-ui/"))).toEqual([]);
    }
  });

  it("loads each heavy command module through a dynamic import", () => {
    const dynamicTargets = graph.flatMap(({ file, source }) =>
      [...source.matchAll(/await import\("([^"]+)"\)/g)].map((m) => toSource(file, m[1] as string)),
    );
    for (const mod of lazyModules) {
      expect(dynamicTargets).toContain(mod);
    }
  });
});

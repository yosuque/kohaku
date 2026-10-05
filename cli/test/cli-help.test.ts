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

describe("cli/src/index.ts imports", () => {
  // `--help` must not load the heavy workspace packages (client, composer, evals, sandbox, lineage, host-core...),
  // so that a partial install still prints help. Each action loads its own module with a static-string dynamic
  // import; a regular value import of one of these modules would pull it back into the startup path. A type-only
  // import is erased at build time and is fine; an inline `import { type X }` is NOT erased under
  // verbatimModuleSyntax (it becomes a side-effect import), so it is rejected here too.
  const source = readFileSync(join(here, "../src/index.ts"), "utf8");
  const lazyModules = ["./commands.js", "./evidence/index.js", "./migrate.js", "./init/index.js"];

  it("has no non-type static import of a heavy command module", () => {
    const staticImports = [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)";/gms)].map(
      (m) => m[1],
    );
    for (const mod of lazyModules) {
      expect(staticImports).not.toContain(mod);
    }
  });

  it("loads each heavy command module through a dynamic import", () => {
    for (const mod of lazyModules) {
      expect(source).toContain(`await import("${mod}")`);
    }
  });
});

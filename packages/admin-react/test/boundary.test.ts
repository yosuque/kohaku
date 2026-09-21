import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The ticket's dependency contract: client + renderer-core (+ sandbox for the promotion preview, spec-core for
// the shared types) → admin-react. Never renderer-react (the console is not a Spec renderer) and never
// host-rest (the console talks to the host only through the typed client). tsc already refuses an import of an
// undeclared workspace package, this test additionally pins the manifest so a stray `pnpm add` is caught too.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = new Set([
  "@kohaku-ui/client",
  "@kohaku-ui/renderer-core",
  "@kohaku-ui/sandbox",
  "@kohaku-ui/spec-core",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("dependency boundary", () => {
  it("declares only the allowed @kohaku-ui dependencies", () => {
    const manifest = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const kohakuDeps = Object.keys(manifest.dependencies ?? {}).filter((d) => d.startsWith("@kohaku-ui/"));
    expect(kohakuDeps.sort()).toEqual([...ALLOWED].sort());
  });

  it("imports only the allowed @kohaku-ui packages from src", () => {
    const offenders: string[] = [];
    for (const file of walk(join(PKG_ROOT, "src"))) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/from\s+"(@kohaku-ui\/[a-z-]+)(?:\/[a-z-]+)?"/g)) {
        if (!ALLOWED.has(m[1]!)) offenders.push(`${file}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveDefaultName, initProject } from "../../src/init/index.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "sales.csv");
const noRun = { run: async () => 0 };

const tmpDirs: string[] = [];
function tmp(prefix = "kohaku-init-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("initProject", () => {
  it("writes the project into --out, names it after the directory, and skips npm install with install: false", async () => {
    const out = join(tmp(), "my-app");
    const result = await initProject({ from: FIXTURE, out, install: false }, noRun);
    expect(result.installed).toBe(false);
    expect(result.profile.source).toBe("sales");
    expect(result.written).toHaveLength(18);
    expect(existsSync(join(out, "server/intents.ts"))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
    expect(pkg.name).toBe("my-app");
    expect(JSON.parse(readFileSync(join(out, "data/sales.json"), "utf8"))).toHaveLength(6);
  });

  it("generates the expected file set and a package.json with no workspace: specifiers", async () => {
    const out = join(tmp(), "app");
    const result = await initProject({ from: FIXTURE, out, install: false }, noRun);
    const expected = [
      "package.json",
      "tsconfig.json",
      "vite.config.ts",
      "index.html",
      "dev.mjs",
      ".env.example",
      ".gitignore",
      "README.md",
      "data/sales.json",
      "server/dataset.ts",
      "server/domain-port.ts",
      "server/intents.ts",
      "server/fixed-specs.ts",
      "server/app.ts",
      "server/main.ts",
      "web/main.tsx",
      "test/golden.test.ts",
      "test/golden/summary.json",
    ].map((p) => join(out, p));
    expect(new Set(result.written)).toEqual(new Set(expected));
    for (const path of expected) expect(existsSync(path)).toBe(true);

    const pkgRaw = readFileSync(join(out, "package.json"), "utf8");
    expect(() => JSON.parse(pkgRaw)).not.toThrow();
    expect(pkgRaw).not.toMatch(/workspace:/);
  });

  it("runs npm install by default through the injected runner", async () => {
    const calls: string[][] = [];
    const out = join(tmp(), "app");
    const result = await initProject(
      { from: FIXTURE, out },
      {
        run: async (cmd, args) => {
          calls.push([cmd, ...args]);
          return 0;
        },
      },
    );
    expect(result.installed).toBe(true);
    expect(calls).toEqual([["npm", "install", "--no-audit", "--no-fund"]]);
  });

  it("throws when the injected install runner exits non-zero", async () => {
    const out = join(tmp(), "app");
    await expect(initProject({ from: FIXTURE, out }, { run: async () => 1 })).rejects.toThrow(
      /npm install exited 1/,
    );
  });

  it("refuses to overwrite: an existing package.json aborts before anything is written", async () => {
    const out = tmp();
    writeFileSync(join(out, "package.json"), "{}");
    await expect(
      initProject({ from: FIXTURE, out, name: "existing-app", install: false }, noRun),
    ).rejects.toThrow(/already exists/);
    expect(existsSync(join(out, "server"))).toBe(false);
    // Not merely "nothing extra visible" -- the directory must be byte-for-byte unchanged.
    expect(readdirSync(out)).toEqual(["package.json"]);
    expect(readFileSync(join(out, "package.json"), "utf8")).toBe("{}");
  });

  it("--source overrides the catalog name", async () => {
    const out = join(tmp(), "app");
    const result = await initProject({ from: FIXTURE, out, source: "Orders 2026", install: false }, noRun);
    expect(result.profile.source).toBe("orders_2026");
    expect(readFileSync(join(out, "server/intents.ts"), "utf8")).toContain('"orders_2026.summary"');
  });

  it("derives the catalog source name from the data file's basename, slugified", async () => {
    const dir = tmp();
    const fancyFixture = join(dir, "Sales Report 2026.csv");
    writeFileSync(fancyFixture, readFileSync(FIXTURE, "utf8"));
    const out = join(dir, "app");
    const result = await initProject({ from: fancyFixture, out, install: false }, noRun);
    expect(result.profile.source).toBe("sales_report_2026");
  });

  it("rejects an invalid npm package name before writing anything", async () => {
    const out = join(tmp(), "app");
    await expect(
      initProject({ from: FIXTURE, out, name: "Invalid Name!", install: false }, noRun),
    ).rejects.toThrow(/not a valid npm package name/);
    expect(existsSync(out)).toBe(false);
  });

  it('normalizes a derived default name instead of rejecting it (e.g. a directory called "My App")', async () => {
    const out = join(tmp(), "My App");
    const result = await initProject({ from: FIXTURE, out, install: false }, noRun);
    expect(result.name).toBe("my_app");
    const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
    expect(pkg.name).toBe("my_app");
  });

  it("falls back to a fixed default name when the output directory's basename carries no name at all", () => {
    // basename("/") === "" (the filesystem root); "." / ".." are handled the same way, defensively,
    // even though `initProject` always resolves `outDir` first so they shouldn't reach here in
    // practice. Unlike slugify's own hash fallback (a real, if opaque, derived name), there is no
    // name to derive here at all, so a fixed, readable default is used instead.
    expect(deriveDefaultName("/")).toBe("kohaku-app");
    expect(deriveDefaultName(".")).toBe("kohaku-app");
    expect(deriveDefaultName("..")).toBe("kohaku-app");
  });

  it("fails with a single-line Node-version message for SQLite input on old Node, driven by a version string", async () => {
    vi.resetModules();
    vi.doMock("semver", async (importOriginal) => {
      // semver's CJS type declaration has no `default` in `typeof import(...)`, but the real
      // interop-transformed module object has one at runtime, hence the untyped `actual` here.
      const actual = (await importOriginal()) as any;
      const fakeGte = (_current: string, range: string) => actual.default.gte("22.10.0", range);
      return { ...actual, default: { ...actual.default, gte: fakeGte }, gte: fakeGte };
    });
    try {
      const { initProject: initProjectWithOldNode } = await import("../../src/init/index.js");
      const out = join(tmp(), "app");
      await expect(
        initProjectWithOldNode({ from: join(dirname(FIXTURE), "sales.sqlite"), out, install: false }, noRun),
      ).rejects.toThrow(/^Reading .* needs Node >= 22\.13/);
    } finally {
      vi.doUnmock("semver");
      vi.resetModules();
    }
  });
});

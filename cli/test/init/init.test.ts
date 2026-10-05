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
    expect(result.written).toHaveLength(20);
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
      ".env",
      ".gitignore",
      "README.md",
      "data/sales.json",
      "server/dataset.ts",
      "server/domain-port.ts",
      "server/intents.ts",
      "server/fixed-specs.ts",
      "server/ports.ts",
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

  it("runs npm install, then a golden-update vitest run without CI, through the injected runner", async () => {
    const calls: { argv: string[]; cwd: string; opts?: { env?: NodeJS.ProcessEnv } }[] = [];
    const logs: string[] = [];
    const out = join(tmp(), "app");
    const result = await initProject(
      { from: FIXTURE, out },
      {
        run: async (cmd, args, cwd, opts) => {
          calls.push({ argv: [cmd, ...args], cwd, ...(opts != null ? { opts } : {}) });
          return 0;
        },
        log: (line) => logs.push(line),
      },
    );
    expect(result.installed).toBe(true);
    expect(result.goldenGenerated).toBe(true);
    expect(calls.map((c) => c.argv)).toEqual([
      ["npm", "install", "--no-audit", "--no-fund"],
      ["npx", "vitest", "run"],
    ]);
    expect(calls[1]?.cwd).toBe(out);
    expect(calls[1]?.opts?.env?.["KOHAKU_GOLDEN_UPDATE"]).toBe("1");
    // CI is explicitly present-and-undefined so the runner strips it from the inherited environment.
    expect(calls[1]?.opts?.env).toHaveProperty("CI", undefined);
    expect(logs).toEqual(["golden: wrote test/golden/*.json expected (npm test is green)"]);
  });

  it.each([
    ["exits non-zero", async () => 1],
    [
      "throws",
      async () => {
        throw new Error("spawn npx ENOENT");
      },
    ],
  ])(
    "does not fail init when the golden-update run %s; it prints the manual command",
    async (_label, golden) => {
      const logs: string[] = [];
      const out = join(tmp(), "app");
      const result = await initProject(
        { from: FIXTURE, out },
        { run: async (cmd) => (cmd === "npm" ? 0 : golden()), log: (line) => logs.push(line) },
      );
      expect(result.installed).toBe(true);
      expect(result.goldenGenerated).toBe(false);
      expect(logs).toEqual([
        `golden: could not generate expected; run "KOHAKU_GOLDEN_UPDATE=1 npm test" once in ${out}`,
      ]);
    },
  );

  it("does not run any child process with install: false", async () => {
    const run = vi.fn(async () => 0);
    const result = await initProject({ from: FIXTURE, out: join(tmp(), "app"), install: false }, { run });
    expect(run).not.toHaveBeenCalled();
    expect(result.installed).toBe(false);
    expect(result.goldenGenerated).toBe(false);
  });

  it("throws when the injected install runner exits non-zero", async () => {
    const out = join(tmp(), "app");
    await expect(initProject({ from: FIXTURE, out }, { run: async () => 1 })).rejects.toThrow(
      /npm install exited 1/,
    );
  });

  it("writes .env with the injected secret, kept separate from .env.example's empty placeholder", async () => {
    const out = join(tmp(), "app");
    await initProject({ from: FIXTURE, out, install: false, secret: () => "fixed-test-secret" }, noRun);
    expect(readFileSync(join(out, ".env"), "utf8")).toContain("KOHAKU_CAPABILITY_SECRET=fixed-test-secret");
    const example = readFileSync(join(out, ".env.example"), "utf8");
    expect(example).toContain("KOHAKU_CAPABILITY_SECRET=\n");
    expect(example).not.toContain("fixed-test-secret");
    expect(example).not.toContain("change-me");
    expect(example).toMatch(/^# KOHAKU_LLM_API_KEY=/m);
  });

  it("defaults to a fresh random secret when none is injected (two runs never collide)", async () => {
    const dir = tmp();
    const outA = join(dir, "a");
    const outB = join(dir, "b");
    await initProject({ from: FIXTURE, out: outA, install: false }, noRun);
    await initProject({ from: FIXTURE, out: outB, install: false }, noRun);
    const secretOf = (out: string) =>
      /KOHAKU_CAPABILITY_SECRET=(\S+)/.exec(readFileSync(join(out, ".env"), "utf8"))?.[1];
    const a = secretOf(outA);
    const b = secretOf(outB);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it(".gitignore excludes .env from version control", async () => {
    const out = join(tmp(), "app");
    await initProject({ from: FIXTURE, out, install: false }, noRun);
    expect(readFileSync(join(out, ".gitignore"), "utf8")).toContain(".env\n");
  });

  it("server/ports.ts delegates the capability secret to createKohakuHost (no hand-rolled fallback secret)", async () => {
    // The secret resolution (env var / whitespace-only-is-missing / no-fallback-secret) now lives in
    // @kohaku-ui/host's createKohakuHost (see packages/host/test/create-host.test.ts) rather than being
    // hand-rolled in the generated project, so this only asserts ports.ts doesn't reimplement or shadow it.
    // (server/ports.ts is where the createKohakuHost() call itself now lives, split out of app.ts so a
    // non-REST front door -- e.g. an MCP server -- can build the same host without Hono routes.)
    const out = join(tmp(), "app");
    await initProject({ from: FIXTURE, out, install: false }, noRun);
    const portsSrc = readFileSync(join(out, "server/ports.ts"), "utf8");
    expect(portsSrc).toContain('import { createKohakuHost, type KohakuHost } from "@kohaku-ui/host";');
    expect(portsSrc).not.toContain("dev-secret-change-me");
    // The env var is still mentioned in prose (a doc comment pointing at createKohakuHost's own
    // resolution), but ports.ts must not read it itself any more.
    expect(portsSrc).not.toContain('process.env["KOHAKU_CAPABILITY_SECRET"]');
    // app.ts no longer calls createKohakuHost directly; it builds the host through server/ports.ts.
    const appSrc = readFileSync(join(out, "server/app.ts"), "utf8");
    expect(appSrc).not.toContain("createKohakuHost");
    expect(appSrc).toContain('import { createPorts, type PortDeps } from "./ports.js";');
  });

  it("server/ports.ts wires debug (KOHAKU_DEBUG) through to createKohakuHost, which wires its own error reporter", async () => {
    // createConsoleErrorReporter (host-rest's onError + the compose observer's onError) is now wired
    // inside createKohakuHost itself (see packages/host/src/create-host.ts), not in the generated project.
    const out = join(tmp(), "app");
    await initProject({ from: FIXTURE, out, install: false }, noRun);
    const portsSrc = readFileSync(join(out, "server/ports.ts"), "utf8");
    expect(portsSrc).not.toContain("createConsoleErrorReporter");
    expect(portsSrc).toContain('debug: process.env["KOHAKU_DEBUG"] === "1"');
    const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
    expect(pkg.dependencies["@kohaku-ui/host"]).toBeDefined();
    expect(pkg.dependencies["@kohaku-ui/host-core"]).toBeUndefined();
  });

  it(".env.example documents KOHAKU_DEBUG", async () => {
    const out = join(tmp(), "app");
    await initProject({ from: FIXTURE, out, install: false }, noRun);
    expect(readFileSync(join(out, ".env.example"), "utf8")).toMatch(/^# KOHAKU_DEBUG=/m);
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

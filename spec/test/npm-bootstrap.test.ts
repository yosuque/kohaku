import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Black-box tests for scripts/npm-bootstrap.mjs, run as a child process the way a maintainer runs it,
 * against a throwaway fixture tree and a local stub registry (never the real npm registry). The child is
 * spawned asynchronously on purpose: the stub registry lives in this process, so a spawnSync would block
 * the event loop that has to answer the child's requests. `--publish` is only exercised with `--dry-run`,
 * which prints the npm commands instead of running them -- nothing here can publish anything.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "npm-bootstrap.mjs");

/** Package documents the stub registry knows (name -> `versions`); every other name answers 404. */
const KNOWN: Record<string, Record<string, { deprecated?: string }>> = {
  "@kohaku-ui/old": { "0.2.0": {} },
  "@kohaku-ui/boot-done": { "0.0.0-bootstrap.0": { deprecated: "placeholder" } },
  "@kohaku-ui/boot-half": { "0.0.0-bootstrap.0": {} },
};

let server: Server;
let registry: string;
const tmpDirs: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "/").slice(1));
    if (name === "@kohaku-ui/broken") {
      res.writeHead(500).end();
      return;
    }
    const versions = KNOWN[name];
    if (versions)
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name, versions }));
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function fixtureRoot(packages: Array<{ name: string; private?: boolean; publishConfig?: boolean }>): string {
  const root = mkdtempSync(join(tmpdir(), "kohaku-npm-bootstrap-test-"));
  tmpDirs.push(root);
  for (const pkg of packages) {
    const dir = join(root, "packages", pkg.name.split("/").pop()!);
    mkdirSync(dir, { recursive: true });
    const manifest: Record<string, unknown> = {
      name: pkg.name,
      license: "Apache-2.0",
      repository: { type: "git", url: "git+https://github.com/yosuque/kohaku.git", directory: "x" },
    };
    if (pkg.private) manifest.private = true;
    if (pkg.publishConfig !== false) manifest.publishConfig = { access: "public" };
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  }
  return root;
}

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, "--registry", registry, ...args], (err, stdout, stderr) => {
      const code = err ? ((err as { code?: number }).code ?? 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

describe("scripts/npm-bootstrap.mjs", () => {
  it("lists only publishable packages and exits 1 when one has never been published", async () => {
    const root = fixtureRoot([
      { name: "@kohaku-ui/old" },
      { name: "@kohaku-ui/new" },
      { name: "@kohaku-ui/contracts", private: true },
      { name: "@kohaku-ui/workspace-only", publishConfig: false },
    ]);
    const { code, stdout } = await run(["--root", root]);
    expect(code).toBe(1);
    expect(stdout).toContain("exists     @kohaku-ui/old");
    expect(stdout).toContain("MISSING    @kohaku-ui/new");
    expect(stdout).not.toContain("contracts");
    expect(stdout).not.toContain("workspace-only");
    expect(stdout).toContain("node scripts/npm-bootstrap.mjs --publish");
  });

  it("exits 0 when every package exists or has a finished bootstrap", async () => {
    const root = fixtureRoot([{ name: "@kohaku-ui/old" }, { name: "@kohaku-ui/boot-done" }]);
    const { code, stdout } = await run(["--root", root]);
    expect(code).toBe(0);
    expect(stdout).toContain("exists     @kohaku-ui/old");
    expect(stdout).toContain("bootstrap  @kohaku-ui/boot-done");
  });

  it("exits 1 for a placeholder that was never deprecated (a bootstrap that stopped part-way)", async () => {
    const root = fixtureRoot([{ name: "@kohaku-ui/boot-half" }]);
    const { code, stdout } = await run(["--root", root]);
    expect(code).toBe(1);
    expect(stdout).toContain("BOOTSTRAP  @kohaku-ui/boot-half (unfinished)");
  });

  it("--publish --dry-run resumes an unfinished bootstrap without publishing the placeholder again", async () => {
    const root = fixtureRoot([{ name: "@kohaku-ui/boot-half" }, { name: "@kohaku-ui/boot-done" }]);
    const { code, stdout } = await run(["--root", root, "--publish", "--dry-run"]);
    expect(code).toBe(0);
    expect(stdout).not.toContain("$ npm publish");
    expect(stdout).toContain("$ npm trust github @kohaku-ui/boot-half");
    expect(stdout).toContain("$ npm deprecate @kohaku-ui/boot-half@0.0.0-bootstrap.0");
    expect(stdout).not.toContain("# @kohaku-ui/boot-done");
  });

  it("--publish --dry-run prints placeholder publish, trusted-publisher and deprecate commands for missing packages only", async () => {
    const root = fixtureRoot([{ name: "@kohaku-ui/old" }, { name: "@kohaku-ui/new" }]);
    const { code, stdout } = await run(["--root", root, "--publish", "--dry-run"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/\$ npm publish \S+ --access public --tag bootstrap --registry/);
    expect(stdout).toContain(
      "$ npm trust github @kohaku-ui/new --file release.yml --repository yosuque/kohaku --environment npm --allow-publish --yes",
    );
    expect(stdout).toContain("$ npm deprecate @kohaku-ui/new@0.0.0-bootstrap.0");
    expect(stdout).not.toContain("# @kohaku-ui/old");
  });

  it("--publish without --dry-run refuses to run without a terminal, before touching the registry", async () => {
    const root = fixtureRoot([{ name: "@kohaku-ui/new" }]);
    const { code, stdout, stderr } = await run(["--root", root, "--publish"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--publish needs an interactive terminal");
    expect(stdout).not.toContain("MISSING");
  });

  it("fails loudly instead of guessing when the registry answers something other than 200/404", async () => {
    const root = fixtureRoot([{ name: "@kohaku-ui/broken" }]);
    const { code, stderr } = await run(["--root", root]);
    expect(code).toBe(2);
    expect(stderr).toContain("answered HTTP 500");
  });
});

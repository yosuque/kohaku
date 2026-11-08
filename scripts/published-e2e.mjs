#!/usr/bin/env node
/**
 * Published-package end-to-end check.
 *
 * `scripts/pack-smoke.mjs` installs `pnpm pack` tarballs built from this commit. It cannot see what a user gets
 * AFTER publishing: the versions npm actually serves, resolved together with the newest versions of every upstream
 * dependency (hono, the MCP SDK, ai-sdk, ...). This script closes that gap. It never reads the workspace packages: it
 * runs `npx @kohaku-ui/cli@<version> init` from an empty directory and exercises the generated project exactly the way
 * a first-time user would. It is meant for the nightly `published-e2e` workflow and for a manual run right after a
 * release (docs/runbooks/release.md); it is deliberately not part of `pnpm test` (it needs the network).
 *
 * Usage: node scripts/published-e2e.mjs [--version <version-or-dist-tag>] [--mcp]
 *   --version  the @kohaku-ui/cli version or dist-tag to run (default: latest)
 *   --mcp      also generate with `--mcp` and exercise the MCP front door (stdio + Streamable HTTP)
 *
 * Steps:
 *   1. `npx --yes @kohaku-ui/cli@<v> init --from scripts/fixtures/init-smoke.csv --out <dir> [--mcp]` (this runs the
 *      generated project's `npm install` and writes the golden); the output must contain `golden: wrote`.
 *   2. `npm test` and `npx tsc --noEmit` in the generated project.
 *   3. `npm start` on a free port: GET /api/health answers {ok: true}, and POST /api/kohaku/compose of the summary
 *      Intent returns an L0 Spec (no LLM provider is configured, so it cannot have come from a model).
 *   4. With --mcp, the same checks pack-smoke's step 7e runs: the stdio server lists its tools and serves the renderer
 *      resource and an L0 summary; the Streamable HTTP server answers `initialize` and refuses a foreign Origin (403).
 *
 * Exit code 0 means every step passed; any failure prints the offending command's output and exits 1.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO_ROOT, "scripts", "fixtures", "init-smoke.csv");
const startedAt = Date.now();

/** Environment variables that would make the generated project talk to a model; the L0 path must work without them. */
const LLM_ENV_KEYS = [
  "KOHAKU_LLM_PROVIDER",
  "KOHAKU_LLM_MODEL",
  "KOHAKU_LLM_API_KEY",
  "KOHAKU_LLM_BASE_URL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
];

let workDir = null;

function elapsed() {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

function log(message) {
  console.log(`[published-e2e] ${message}`);
}

function step(n, title) {
  console.log(`\n[published-e2e] === Step ${n}: ${title} (${elapsed()}) ===`);
}

function cleanup() {
  if (workDir == null) return;
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`[published-e2e] warning: failed to clean up ${workDir}: ${err}`);
  }
}

/** Fail fast: print the diagnostics, clean up, exit non-zero. Never returns. */
function fail(message, details) {
  console.error(`\n[published-e2e] FAILURE (${elapsed()}): ${message}`);
  if (details) console.error(details);
  cleanup();
  process.exit(1);
}

function parseArgs(argv) {
  const options = { version: "latest", mcp: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mcp") {
      options.mcp = true;
    } else if (arg === "--version") {
      const value = argv[i + 1];
      if (value === undefined) fail("--version needs a value");
      options.version = value;
      i += 1;
    } else {
      fail(`unknown argument ${JSON.stringify(arg)}`, "usage: node scripts/published-e2e.mjs [--version <v>] [--mcp]");
    }
  }
  // The value ends up as an npx package specifier; reject anything that is not a plain version or dist-tag
  // (in particular a leading `-`, which npx would read as an option).
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(options.version)) {
    fail(`--version ${JSON.stringify(options.version)} is not a version or dist-tag`);
  }
  return options;
}

/** Environment for child processes: the caller's, minus anything that would configure an LLM provider. */
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of LLM_ENV_KEYS) delete env[key];
  return env;
}

/** Runs a command to completion, captures its output and fails the whole run on a non-zero exit. */
function runOrFail(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: opts.cwd,
    env: opts.env ?? cleanEnv(),
    maxBuffer: 1024 * 1024 * 64,
  });
  if (result.error) fail(`could not run \`${cmd} ${args.join(" ")}\``, String(result.error));
  if (result.status !== 0) {
    fail(
      `\`${cmd} ${args.join(" ")}\` exited ${result.status}${opts.cwd ? ` (cwd: ${opts.cwd})` : ""}`,
      `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
  return result;
}

/** Finds an unused TCP port by binding to port 0 and reading back what the OS assigned. */
function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
  });
}

/**
 * Spawns a long-running server (not spawnSync: it must keep running while we talk to it), retries `probe()` until it
 * resolves or `timeoutMs` elapses, then always tears the whole process group down (`npm start` is an npm -> sh -> node
 * chain; killing only the parent would leave the server holding its port). Rejects instead of calling fail() so the
 * caller can attach a contextualized message.
 */
async function withBackgroundServer(cmd, args, opts, probe, timeoutMs = 15_000) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => {
    stdout += String(d);
  });
  child.stderr?.on("data", (d) => {
    stderr += String(d);
  });
  const exited = new Promise((resolveExit) => child.on("exit", (code) => resolveExit(code)));
  try {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    for (;;) {
      if (child.exitCode !== null) {
        throw new Error(`server exited early (code ${child.exitCode})\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
      }
      try {
        return await probe();
      } catch (err) {
        lastError = err;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for the server to respond: ${lastError}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // the group is already gone
    }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  }
}

async function checkRest(appDir, canonical) {
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  try {
    await withBackgroundServer("npm", ["start"], { cwd: appDir, env: cleanEnv({ PORT: String(port) }) }, async () => {
      const health = await fetch(`${base}/api/health`);
      const healthBody = await health.json();
      if (health.status !== 200 || healthBody.ok !== true) {
        throw new Error(`/api/health answered ${health.status}: ${JSON.stringify(healthBody).slice(0, 300)}`);
      }
      const compose = await fetch(`${base}/api/kohaku/compose`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: { canonical, params: {} }, session: { surface: "web" } }),
      });
      const body = await compose.json();
      const tier = body.spec?.provenance?.tier;
      if (compose.status !== 200 || tier !== "L0") {
        throw new Error(`/api/kohaku/compose answered ${compose.status}, tier=${tier}: ${JSON.stringify(body).slice(0, 300)}`);
      }
      log(`  GET /api/health -> {ok: true}; POST /api/kohaku/compose (${canonical}) -> L0 spec with ${body.spec.components.length} components`);
    });
  } catch (err) {
    fail(`the generated project's \`npm start\` did not serve /api/health and an L0 compose on :${port}`, String(err));
  }
}

async function checkMcp(appDir) {
  const tsxCli = join(appDir, "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(tsxCli)) fail(`the generated project has no tsx at ${tsxCli}`);

  // @modelcontextprotocol/client is not a dependency of the generated project (it only plays the server role), so the
  // client library goes into its own directory; its latest published version is deliberately what is exercised.
  const clientDir = join(workDir, "mcp-client");
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(
    join(clientDir, "package.json"),
    JSON.stringify({ name: "kohaku-published-e2e-mcp-client", private: true, type: "module" }, null, 2),
  );
  runOrFail("npm", ["install", "--no-audit", "--no-fund", "@modelcontextprotocol/client"], { cwd: clientDir });

  // --- stdio: tools/list, resources/read and an L0 summary, with no LLM env vars at all ---
  const stdioScript = join(clientDir, "check-stdio.mjs");
  writeFileSync(
    stdioScript,
    `
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const env = getDefaultEnvironment();
for (const key of ${JSON.stringify(LLM_ENV_KEYS)}) delete env[key];

const transport = new StdioClientTransport({
  command: ${JSON.stringify(process.execPath)},
  args: [${JSON.stringify(tsxCli)}, ${JSON.stringify(join(appDir, "server", "mcp.ts"))}],
  cwd: ${JSON.stringify(appDir)},
  env,
});
const client = new Client({ name: "kohaku-published-e2e", version: "0.1.0" }, { versionNegotiation: { mode: "auto" } });
await client.connect(transport);
try {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  if (!names.includes("kohaku_compose")) throw new Error("tools/list is missing kohaku_compose: " + names.join(", "));
  const summaryTool = names.find((n) => n.endsWith("_summary"));
  if (summaryTool == null) throw new Error("tools/list has no generated *_summary tool: " + names.join(", "));
  const read = await client.readResource({ uri: "ui://kohaku/renderer.html" });
  const html = read.contents[0]?.text ?? "";
  if (!html.includes('<meta name="kohaku-renderer" content="core"')) {
    throw new Error("resources/read ui://kohaku/renderer.html is missing the core-build marker");
  }
  const result = await client.callTool({ name: summaryTool, arguments: {} });
  if (result.isError === true) throw new Error("the summary tool call failed: " + JSON.stringify(result.content));
  const tier = result.structuredContent?.spec?.provenance?.tier;
  if (tier !== "L0") throw new Error("the summary tool did not return an L0 spec (tier=" + tier + ")");
  console.log("ok");
} finally {
  await client.close();
}
`,
  );
  runOrFail("node", [stdioScript], { cwd: clientDir });
  log("  stdio MCP server: tools/list has kohaku_compose + a *_summary tool, resources/read has the core marker, the summary composes L0");

  // --- Streamable HTTP: answers initialize on a free port and refuses a foreign Origin / preflight ---
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}/mcp`;
  const post = (body, headers = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    });
  try {
    await withBackgroundServer(
      process.execPath,
      [tsxCli, join(appDir, "server", "mcp-http.ts")],
      { cwd: appDir, env: cleanEnv({ PORT: String(port) }) },
      async () => {
        const init = await post({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2026-07-28",
            capabilities: {},
            clientInfo: { name: "kohaku-published-e2e", version: "0.1.0" },
          },
        });
        const text = await init.text();
        if (!init.ok) throw new Error(`initialize returned ${init.status}: ${text.slice(0, 300)}`);
        if (!text.includes("serverInfo") && !text.includes("protocolVersion")) {
          throw new Error(`initialize response did not look like an MCP result: ${text.slice(0, 300)}`);
        }
        // A browser page must not be able to drive the server (DNS rebinding / CSRF); a client that sends no Origin
        // (the request above) is not affected.
        const badOrigin = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { origin: "http://evil.example" });
        if (badOrigin.status !== 403) throw new Error(`a foreign Origin got ${badOrigin.status}, expected 403`);
        const preflight = await fetch(url, {
          method: "OPTIONS",
          headers: { origin: "http://evil.example", "access-control-request-method": "POST" },
        });
        if (preflight.status !== 403) throw new Error(`a foreign-Origin preflight got ${preflight.status}, expected 403`);
      },
    );
  } catch (err) {
    fail(`the generated project's mcp-http server did not behave on :${port}`, String(err));
  }
  log(`  Streamable HTTP MCP server (:${port}): answers initialize, refuses a foreign Origin and its preflight (403)`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const label = `@kohaku-ui/cli@${options.version}${options.mcp ? " --mcp" : ""}`;
  log(`checking the published ${label}`);

  workDir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "kohaku-published-e2e-"));
  const appDir = join(workDir, "app");

  step(1, `npx @kohaku-ui/cli@${options.version} init${options.mcp ? " --mcp" : ""} (installs the generated project from the registry)`);
  // Run from the empty work directory, never from the repository: inside the workspace npx could resolve the local
  // package instead of what the registry serves.
  const initArgs = ["--yes", `@kohaku-ui/cli@${options.version}`, "init", "--from", FIXTURE, "--out", appDir];
  if (options.mcp) initArgs.push("--mcp");
  const init = runOrFail("npx", initArgs, { cwd: workDir });
  if (!init.stdout.includes("golden: wrote")) {
    fail("`kohaku init` did not report `golden: wrote` (the golden expected could not be generated)", `--- stdout ---\n${init.stdout}\n--- stderr ---\n${init.stderr}`);
  }
  const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
  const kohakuRange = Object.entries(pkg.dependencies ?? {}).find(([name]) => name.startsWith("@kohaku-ui/"));
  log(`  init succeeded and reported \`golden: wrote\` (generated project pins ${kohakuRange?.join(" ")})`);

  const golden = JSON.parse(readFileSync(join(appDir, "test", "golden", "summary.json"), "utf8"));
  const canonical = golden.input?.intent?.canonical;
  if (typeof canonical !== "string") fail("test/golden/summary.json has no input.intent.canonical", JSON.stringify(golden).slice(0, 300));

  step(2, "npm test + tsc --noEmit in the generated project");
  runOrFail("npm", ["test"], { cwd: appDir });
  log("  npm test passes (golden regression asserted)");
  runOrFail("npx", ["tsc", "--noEmit"], { cwd: appDir });
  log("  tsc --noEmit passes");

  step(3, "npm start: /api/health and an L0 compose over HTTP");
  await checkRest(appDir, canonical);

  if (options.mcp) {
    step(4, "MCP front door: stdio + Streamable HTTP");
    await checkMcp(appDir);
  }

  cleanup();
  log(`\nOK: the published ${label} generates a project that installs, tests, type-checks and serves (${elapsed()})`);
}

main().catch((err) => fail("unexpected error", err instanceof Error ? (err.stack ?? String(err)) : String(err)));

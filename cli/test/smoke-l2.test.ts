import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SmokeL2Input, SmokeL2Output } from "../src/commands.js";

// smoke-l2 is a stdin/stdout contract the Python sidecar depends on, so we spawn the real process
// (bin/kohaku.js → tsx) and verify it end to end. Because it includes tsx startup + jsdom, one case can take a few seconds.
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "kohaku.js");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(input: unknown): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, "smoke-l2"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.stdin.write(typeof input === "string" ? input : JSON.stringify(input));
    child.stdin.end();
  });
}

// Shorten the no-ready timeout wait to keep tests fast (the sidecar can pass readyTimeoutMs).
const READY_TIMEOUT_MS = 300;

const VALID_HTML =
  '<!DOCTYPE html><html><body><div id="x"></div><script>' +
  'window.kohaku.fetchData("query://x").then(function(d){' +
  'document.getElementById("x").textContent=String(d.rows.length);window.kohaku.ready();});' +
  "</script></body></html>";

// An unterminated string literal ('<div> containing a newline) = a JS syntax error. It does not touch
// lexical lint (missing ready, etc.), so we can confirm that only L2_SCRIPT_SYNTAX appears in lint mode.
const SYNTAX_ERROR_HTML =
  "<!DOCTYPE html><html><body><script>\nlet s = '<div>\n';\nwindow.kohaku.ready();\n</script></body></html>";

describe("kohaku smoke-l2 (sidecar stdin/stdout contract)", { timeout: 30_000 }, () => {
  it("lint mode: HTML with a syntax error returns L2_SCRIPT_SYNTAX and exits 0", async () => {
    const input: SmokeL2Input = { html: SYNTAX_ERROR_HTML, mode: "lint" };
    const res = await runCli(input);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as SmokeL2Output;
    expect(out.issues.some((i) => i.startsWith("L2_SCRIPT_SYNTAX"))).toBe(true);
  });

  it("lint mode: syntactically valid HTML has empty issues", async () => {
    const input: SmokeL2Input = { html: VALID_HTML, mode: "lint" };
    const res = await runCli(input);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as SmokeL2Output;
    expect(out.issues).toEqual([]);
  });

  it("smoke mode: HTML that reaches ready() has empty issues", async () => {
    const input: SmokeL2Input = {
      html: "<!DOCTYPE html><html><body><script>window.kohaku.ready();</script></body></html>",
      mode: "smoke",
      readyTimeoutMs: READY_TIMEOUT_MS,
    };
    const res = await runCli(input);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as SmokeL2Output;
    expect(out.issues).toEqual([]);
  });

  it("smoke mode: HTML that does not call ready() yields L2_SMOKE_NO_READY", async () => {
    const input: SmokeL2Input = {
      html: "<!DOCTYPE html><html><body><script>void 0;</script></body></html>",
      mode: "smoke",
      readyTimeoutMs: READY_TIMEOUT_MS,
    };
    const res = await runCli(input);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as SmokeL2Output;
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0]).toMatch(/^L2_SMOKE_NO_READY/);
  });

  it("invalid input JSON exits 1 with an error message on stderr", async () => {
    const res = await runCli("{ not json");
    expect(res.code).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toMatch(/smoke-l2/);
  });
});

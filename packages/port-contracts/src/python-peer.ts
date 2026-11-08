import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How a backend-backed TS test finds the Python half of a cross-language test (the Python storage adapters of
 * `python/kohaku/src/kohaku/storage`, driven through `python/kohaku/tests/storage/interop_peer.py`). The adapters
 * are written twice and must be able to share one Redis / Postgres, so the check that actually proves it starts a
 * process in each language against the same backend.
 *
 * The interpreter is `KOHAKU_PYTHON`, else the workspace venv `uv sync` creates (`python/.venv/bin/python`); a
 * machine that has not run `uv sync` skips the test, like a machine without a backend skips the contract suites.
 * `KOHAKU_ADAPTER_TESTS=require` turns the skip into a failure, so a CI job that is supposed to run it can never pass
 * by silently skipping.
 */
export type PythonPeer = { mode: "run"; python: string; script: string } | { mode: "skip"; reason: string };

/** The repository root: this file is `packages/port-contracts/src/python-peer.ts`. */
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Hides the backend URL (and any credentials in it) from an error message: a CI log must not carry them. */
export function redact(text: string, url: string): string {
  return text
    .split(url)
    .join("<backend url>")
    .replace(/\/\/[^/\s@]*@/g, "//<credentials>@");
}

export function resolvePythonPeer(
  env: Record<string, string | undefined> = process.env,
  repoRoot: string = REPO_ROOT,
  exists: (path: string) => boolean = existsSync,
): PythonPeer {
  const python = env["KOHAKU_PYTHON"] || join(repoRoot, "python", ".venv", "bin", "python");
  const script = join(repoRoot, "python", "kohaku", "tests", "storage", "interop_peer.py");
  if (exists(python) && exists(script)) return { mode: "run", python, script };
  const reason = `no Python peer: ${python} does not exist (run \`uv sync\` in python/ or set KOHAKU_PYTHON)`;
  if (env["KOHAKU_ADAPTER_TESTS"] === "require") {
    throw new Error(`${reason} — KOHAKU_ADAPTER_TESTS=require forbids skipping this suite`);
  }
  return { mode: "skip", reason };
}

/**
 * Runs `interop_peer.py <backend> <url> <namespace> <command>` and returns the JSON document it printed. A non-zero
 * exit rejects with the peer's stderr, which is where its assertion messages go.
 */
export function runPythonPeer(
  peer: Extract<PythonPeer, { mode: "run" }>,
  backend: "redis" | "postgres",
  url: string,
  namespace: string,
  command: "adopt" | "seed" | "verify",
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      peer.python,
      ["-I", peer.script, backend, url, namespace, command],
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error != null) {
          // execFile's message repeats the whole command line, which carries the backend URL.
          reject(new Error(redact(`python peer \`${command}\` failed: ${error.message}\n${stderr}`, url)));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(
            new Error(
              redact(`python peer \`${command}\` printed no JSON document:\n${stdout}\n${stderr}`, url),
            ),
          );
        }
      },
    );
  });
}

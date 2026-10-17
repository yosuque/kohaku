import { collectScriptSyntaxIssues } from "@kohaku-ui/composer";
import { createL2Smoke } from "@kohaku-ui/sandbox/smoke";
import type { DataShape } from "@kohaku-ui/spec-core";

/**
 * Input for the smoke-l2 subcommand (stdin JSON).
 * A sidecar contract that lets the Python implementation, which has no JS runtime, reuse the
 * TS validation logic in a "Node co-located environment". lint is the <script> syntax check, smoke is the
 * ready-reached check under jsdom execution.
 */
export interface SmokeL2Input {
  /** The L2-generated HTML to validate (a single HTML document). */
  html: string;
  /** Synthetic data source for smoke mode. Unused in lint. */
  shape?: DataShape;
  /** lint = <script> syntax check only / smoke = ready-reached check under jsdom execution. */
  mode: "lint" | "smoke";
  /** Upper bound (ms) for waiting on ready in smoke mode. Defaults to createL2Smoke's default (1000) when omitted. */
  readyTimeoutMs?: number;
}

/** Output of the smoke-l2 subcommand (stdout JSON). A non-empty issues list is sent back for repair. */
export interface SmokeL2Output {
  issues: string[];
}

/**
 * Parse the smoke-l2 stdin JSON with validation. A malformed shape is rejected with a single-line error (the sidecar's exit 1).
 */
export function parseSmokeL2Input(json: string): SmokeL2Input {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`Cannot parse the smoke-l2 stdin JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  const obj = parsed as Record<string, unknown> | null;
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("The smoke-l2 input must be a JSON object");
  }
  if (typeof obj["html"] !== "string") {
    throw new Error("The smoke-l2 input html must be a string");
  }
  if (obj["mode"] !== "lint" && obj["mode"] !== "smoke") {
    throw new Error('The smoke-l2 input mode must be "lint" or "smoke"');
  }
  const readyTimeoutMs = obj["readyTimeoutMs"];
  if (readyTimeoutMs != null && (typeof readyTimeoutMs !== "number" || !Number.isFinite(readyTimeoutMs))) {
    throw new Error("The smoke-l2 input readyTimeoutMs must be a number");
  }
  const shape = obj["shape"];
  if (shape != null && (typeof shape !== "object" || Array.isArray(shape))) {
    throw new Error("The smoke-l2 input shape must be a DataShape object");
  }
  return {
    html: obj["html"],
    mode: obj["mode"],
    ...(shape != null ? { shape: shape as DataShape } : {}),
    ...(readyTimeoutMs != null ? { readyTimeoutMs: readyTimeoutMs as number } : {}),
  };
}

/**
 * The smoke-l2 validation core. lint reuses composer's syntax-check part, and smoke reuses sandbox's jsdom
 * smoke (avoiding a duplicate implementation of the validation logic and keeping the TS side the single source of truth).
 * lint does not run the lexical-lint items (hallucinated APIs, missing ready, etc.) — the Python side has its own,
 * so from TS we borrow only the check part that requires JS execution.
 */
export async function runSmokeL2(input: SmokeL2Input): Promise<SmokeL2Output> {
  if (input.mode === "lint") {
    return { issues: collectScriptSyntaxIssues(input.html) };
  }
  const smoke = createL2Smoke(input.readyTimeoutMs != null ? { readyTimeoutMs: input.readyTimeoutMs } : {});
  const issues = await smoke(input.html, input.shape != null ? { shape: input.shape } : {});
  return { issues };
}

/** The exact stdout of a successful smoke-l2 run: one JSON line, newline-terminated (written with `process.stdout.write`). */
export function formatSmokeL2Output(output: SmokeL2Output): string {
  return `${JSON.stringify(output)}\n`;
}

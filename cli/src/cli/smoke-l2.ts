import type { Command } from "commander";
import type { SmokeL2Output } from "../commands.js";
import { errorMessage } from "./shared.js";

/** Reads stdin to completion and returns it as a string (the smoke-l2 sidecar's one-request-one-process contract). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Registers `kohaku smoke-l2`. The runner module is loaded lazily by the action. */
export function register(program: Command): void {
  program
    .command("smoke-l2")
    .description(
      "Validate the L2 HTML from stdin and return issues as JSON (for sidecar use by implementations without a JS runtime)." +
        'stdin: {"html":"...","mode":"lint"|"smoke","shape"?:DataShape,"readyTimeoutMs"?:number} / ' +
        'stdout: {"issues":string[]}. mode lint=<script> syntax check / smoke=ready-reached check under jsdom execution',
    )
    .action(async () => {
      // Failures at the read / parse / run stages are returned as a single stderr line + exit 1 rather than a stack
      // (so the caller can swallow them fail-open). On success, write one JSON line to stdout and exit 0.
      let raw: string;
      try {
        raw = await readStdin();
      } catch (e) {
        process.stderr.write(`smoke-l2: failed to read stdin (${errorMessage(e)})\n`);
        process.exitCode = 1;
        return;
      }
      const { formatSmokeL2Output, parseSmokeL2Input, runSmokeL2 } = await import("../commands.js");
      let output: SmokeL2Output;
      try {
        output = await runSmokeL2(parseSmokeL2Input(raw));
      } catch (e) {
        process.stderr.write(`smoke-l2: ${errorMessage(e)}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(formatSmokeL2Output(output));
    });
}

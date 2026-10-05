/**
 * Helpers shared by more than one command's registration module (`cli/src/cli/<command>.ts`). This module is
 * loaded at startup by every `--help`, so it stays light: `commander` and type-only imports, nothing else (the
 * startup-graph test in `test/cli-help.test.ts` enforces it).
 */
import { type Command, type CommanderError, Option } from "commander";
import type { LineageSourceArgs, LineageSourceCliOptions } from "../lineage-window.js";

/** The one-line message shown for a caught failure (no stack trace). */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Prints `e`'s message and exits with `exitCode` through commander (which calls `process.exit`). `program` is
 * always the ROOT command, never the subcommand whose action failed, so the error line carries the root's
 * formatting exactly as before the split into modules.
 *
 * The declared `never` return on a function declaration is load-bearing: TypeScript only treats a call to a
 * `never`-returning function as ending control flow when the callee has an explicit type annotation, which is
 * what lets `fail(program, e)` narrow the code after a failed `try` without a `return`.
 */
export function fail(program: Command, e: unknown, exitCode = 1): never {
  return program.error(errorMessage(e), { exitCode });
}

/** A repeatable `--header <name:value>` option: each occurrence is appended to the `header` string array. */
export function headerOption(description: string): Option {
  return new Option("--header <name:value>", description)
    .argParser((value: string, prev: string[]) => [...prev, value])
    .default([] as string[]);
}

/**
 * Adds the six options `evidence export` and `usage export` share, in help order: `--data-dir`, `--rest`,
 * `--header`, `--tenant`, then the required `--since` / `--until`. The descriptions that differ per command are
 * passed in; the commander option bag is `LineageSourceCliOptions`.
 */
export function addLineageSourceOptions(
  cmd: Command,
  help: { rest: string; tenant: string; since: string; until: string },
): Command {
  return cmd
    .option(
      "--data-dir <dir>",
      "Read from a local StoragePort data directory (mutually exclusive with --rest)",
    )
    .option("--rest <baseUrl>", help.rest)
    .addOption(headerOption("Extra REST request header, e.g. tenant or auth (repeatable; --rest only)"))
    .option("--tenant <id>", help.tenant)
    .requiredOption("--since <iso8601>", help.since)
    .requiredOption("--until <iso8601>", help.until);
}

/** Maps the commander option bag of a lineage-reading subcommand onto the runner's `LineageSourceArgs`. */
export function lineageSourceArgs(opts: LineageSourceCliOptions): LineageSourceArgs {
  return {
    ...(opts.dataDir != null ? { dataDir: opts.dataDir } : {}),
    ...(opts.rest != null ? { rest: opts.rest } : {}),
    headers: opts.header,
    ...(opts.tenant != null ? { tenant: opts.tenant } : {}),
    since: opts.since,
    until: opts.until,
  };
}

/**
 * `exitOverride` handler for the evidence / usage subcommands whose exit code 1 means "invalid pack" / a runtime
 * failure: commander's own usage errors (a missing required option, an unknown option, a bad argument)
 * default to exit 1 and would collide with it, so they exit 2 instead. `--help` / `--version` carry exit
 * code 0 and stay 0. Commander has already printed the message by the time this runs.
 */
export function exitUsageErrorAsTwo(err: CommanderError): never {
  process.exit(err.exitCode === 0 ? 0 : 2);
}

import type { Command } from "commander";
import type { LineageSourceCliOptions } from "../lineage-window.js";
import { addLineageSourceOptions, exitUsageErrorAsTwo, fail, lineageSourceArgs } from "./shared.js";

/** Registers `kohaku usage` (`export`). The runner module is loaded lazily by the action. */
export function register(program: Command): void {
  const usage = program
    .command("usage")
    .description("Usage metering derived from the lineage log (design.md #74)");

  addLineageSourceOptions(
    usage
      .command("export")
      .exitOverride(exitUsageErrorAsTwo)
      .description(
        "Export per-day, per-tenant usage (compositions, cache, tiers, L2 generations, fallbacks, tokens, " +
          "fixations) from the whole lineage log of a local StoragePort data directory or a REST host",
      ),
    {
      rest:
        "Read over REST from a running host (mutually exclusive with --data-dir). The x-kohaku-tenant " +
        "--header decides the tenant (export each tenant with its own header); without the header every " +
        "tenant is read (legacy, unscoped hosts)",
      tenant:
        "Restrict the export to this tenant (--data-dir; omitted = every tenant, one row per day and tenant). " +
        "In --rest mode this must match the x-kohaku-tenant --header",
      since:
        "Inclusive lower bound: a date (YYYY-MM-DD, start of that UTC day) or a timestamp with a Z / ±hh:mm offset",
      until:
        "Inclusive upper bound: a date (YYYY-MM-DD, which INCLUDES that whole UTC day) or a timestamp with a Z / ±hh:mm offset",
    },
  )
    .option(
      "--timeout-ms <ms>",
      "Time limit of each --rest request, in milliseconds (a slower request fails the export)",
      "30000",
    )
    .option("--format <csv|json>", "Output format", "csv")
    .option(
      "--out <file>",
      "Write to this file instead of stdout (written to <file>.tmp first, then renamed into place)",
    )
    .action(async (opts: LineageSourceCliOptions & { timeoutMs: string; format: string; out?: string }) => {
      const { CliUsageError } = await import("../usage-error.js");
      const { formatUsageExportResult, runUsageExport } = await import("../usage/index.js");
      let result: Awaited<ReturnType<typeof runUsageExport>>;
      try {
        result = await runUsageExport({
          ...lineageSourceArgs(opts),
          timeoutMs: Number(opts.timeoutMs),
          format: opts.format as "csv" | "json",
          ...(opts.out != null ? { out: opts.out } : {}),
        });
      } catch (e) {
        // A bad argument (window, format, source, data dir, tenant) is a usage error (exit 2); anything else is 1.
        fail(program, e, e instanceof CliUsageError ? 2 : 1);
      }
      if (result.outPath != null) {
        console.error(formatUsageExportResult(result));
      } else {
        process.stdout.write(formatUsageExportResult(result));
      }
    });
}

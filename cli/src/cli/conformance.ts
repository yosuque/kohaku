import type { ConformanceReport } from "@kohaku-ui/spec/conformance";
import type { Command } from "commander";
import { fail } from "./shared.js";

/** Registers `kohaku conformance`. The runner module is loaded lazily by the action. */
export function register(program: Command): void {
  program
    .command("conformance")
    .description("Run the specification conformance suite (SPEC.md §7)")
    .option("--self", "Self-check of the Spec format only")
    .option("--rest <baseUrl>", "Black-box check against a REST host (e.g. http://localhost:8787/api/kohaku)")
    .option("--intent <json>", "Intent used for the check (default: sales.quarterly_summary)")
    .action(async (opts: { self?: boolean; rest?: string; intent?: string }) => {
      if (opts.rest == null && opts.self !== true) {
        program.error("Specify either --self or --rest <baseUrl>");
      }
      const { formatReport, runRestConformance, runSelfConformance } = await import("../commands.js");
      let report: ConformanceReport;
      try {
        report =
          opts.rest != null ? await runRestConformance(opts.rest, opts.intent) : await runSelfConformance();
      } catch (e) {
        // Show a malformed --intent shape or a network failure as a single line rather than a stack trace.
        // `fail` is typed `never`, so the compiler knows `report` is assigned after this try/catch.
        fail(program, e);
      }
      console.log(formatReport(report));
      process.exitCode = report.pass ? 0 : 1;
    });
}

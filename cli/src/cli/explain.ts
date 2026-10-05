import type { ExplainReport } from "@kohaku-ui/client";
import type { Command } from "commander";
import { fail, headerOption } from "./shared.js";

/** Registers `kohaku explain`. The runner module is loaded lazily by the action. */
export function register(program: Command): void {
  program
    .command("explain")
    .argument(
      "<requestId>",
      "Request id to explain (a compose's X-Request-Id, or an MCP tool call's mcp:... correlation id)",
    )
    .description(
      "Explain why a compose came out the way it did (tier, cache, cache-key breakdown, decision flow, related lineage events)",
    )
    .requiredOption("--rest <baseUrl>", "REST host base URL (e.g. http://localhost:8787/api/kohaku)")
    .addOption(headerOption("Extra request header, e.g. tenant or auth (repeatable)"))
    .option("--json", "Output the raw ExplainReport JSON instead of formatted text")
    .option("--spec <file>", "Path to a UISpec JSON file; adds capability scopes to the report")
    .action(
      async (requestId: string, opts: { rest: string; header: string[]; json?: boolean; spec?: string }) => {
        const { formatExplainReport, runExplain } = await import("../commands.js");
        const { CliUsageError } = await import("../usage-error.js");
        let report: ExplainReport;
        try {
          report = await runExplain(requestId, {
            rest: opts.rest,
            headers: opts.header,
            ...(opts.spec != null ? { specPath: opts.spec } : {}),
          });
        } catch (e) {
          // A malformed --header is a usage error (exit 2); anything else is 1.
          fail(program, e, e instanceof CliUsageError ? 2 : 1);
        }
        console.log(opts.json === true ? JSON.stringify(report, null, 2) : formatExplainReport(report));
      },
    );
}

#!/usr/bin/env node
import type { ExplainReport } from "@kohaku-ui/client";
import type { ConformanceReport } from "@kohaku-ui/spec/conformance";
import { Command } from "commander";
import { register as registerComponent } from "./cli/component.js";
import { register as registerDataset } from "./cli/dataset.js";
import { register as registerEvidence } from "./cli/evidence.js";
import { register as registerInit } from "./cli/init.js";
import { register as registerMigrate } from "./cli/migrate.js";
import { register as registerScaffold } from "./cli/scaffold.js";
import { fail, headerOption } from "./cli/shared.js";
import { register as registerSmokeL2 } from "./cli/smoke-l2.js";
import { register as registerUsage } from "./cli/usage.js";
import { CLI_VERSION } from "./version.js";

// The explicit `Command` annotation is load-bearing: TypeScript only treats a call to a `never`-returning
// function as ending control flow when the callee expression has an explicit type annotation, which is what
// lets `program.error(...)` / `fail(...)` below narrow the code after a failed `try` without a `return`.
const program: Command = new Command("kohaku")
  .description(
    "CLI for kohaku: protocol conformance checks, scaffolding, project generation and component validation",
  )
  .version(CLI_VERSION);

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
    const { formatReport, runRestConformance, runSelfConformance } = await import("./commands.js");
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
      const { formatExplainReport, runExplain } = await import("./commands.js");
      const { CliUsageError } = await import("./usage-error.js");
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

registerScaffold(program);

registerInit(program);

registerSmokeL2(program);

registerComponent(program);

registerDataset(program);

registerEvidence(program);

registerUsage(program);

registerMigrate(program);

await program.parseAsync();

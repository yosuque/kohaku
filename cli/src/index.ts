#!/usr/bin/env node
import type { ConformanceReport } from "@kohaku-ui/spec/conformance";
import { Command } from "commander";
import { register as registerComponent } from "./cli/component.js";
import { register as registerDataset } from "./cli/dataset.js";
import { register as registerEvidence } from "./cli/evidence.js";
import { register as registerExplain } from "./cli/explain.js";
import { register as registerInit } from "./cli/init.js";
import { register as registerMigrate } from "./cli/migrate.js";
import { register as registerScaffold } from "./cli/scaffold.js";
import { fail } from "./cli/shared.js";
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

registerExplain(program);

registerScaffold(program);

registerInit(program);

registerSmokeL2(program);

registerComponent(program);

registerDataset(program);

registerEvidence(program);

registerUsage(program);

registerMigrate(program);

await program.parseAsync();

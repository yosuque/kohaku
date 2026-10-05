#!/usr/bin/env node
import type { ExplainReport } from "@kohaku-ui/client";
import type { ConformanceReport } from "@kohaku-ui/spec/conformance";
import { Command } from "commander";
import { register as registerDataset } from "./cli/dataset.js";
import { register as registerEvidence } from "./cli/evidence.js";
import { register as registerMigrate } from "./cli/migrate.js";
import { errorMessage, fail, headerOption } from "./cli/shared.js";
import { register as registerUsage } from "./cli/usage.js";
import type { SmokeL2Output } from "./commands.js";
import type { InitResult } from "./init/index.js";
import { CLI_VERSION } from "./version.js";

/** Reads stdin to completion and returns it as a string (the smoke-l2 sidecar's one-request-one-process contract). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

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

program
  .command("scaffold")
  .argument("<what>", '"ports" or "golden"')
  .option("--out <dir>", "Output directory (default depends on the target)")
  .description("Generate scaffolds for product-side Port implementations / Golden regression tests")
  .action(async (what: string, opts: { out?: string }) => {
    // The default output directory, the post-generation "next steps" and the files come from the target's
    // table entry. Validate the target before loading anything else, so that a typo does not pay for (or fail
    // on) a heavy module import; `scaffold-targets.js` itself is light (the embedded templates only).
    const { SCAFFOLD_TARGETS } = await import("./scaffold-targets.js");
    const target = Object.hasOwn(SCAFFOLD_TARGETS, what) ? SCAFFOLD_TARGETS[what] : undefined;
    if (target == null) program.error(`Unknown scaffold target: ${what} (allowed: ports / golden)`);
    const { writeScaffold } = await import("./scaffold-fs.js");
    let written: string[];
    try {
      written = writeScaffold(target.files(opts.out ?? target.defaultOut));
    } catch (e) {
      // As with the conformance action, show failures such as existing-file collisions as a single line (no raw stack).
      fail(program, e);
    }
    console.log("Generated:");
    for (const path of written) console.log(`  ${path}`);
    console.log(`\nNext steps: ${target.next}`);
  });

program
  .command("init")
  .description(
    "Generate a runnable kohaku app (server + dashboard + chat) from a data file, then npm install",
  )
  .requiredOption("--from <file>", "Data file: .csv, .json (array of objects) or .sqlite / .db")
  .option("--out <dir>", "Output directory (default: the current directory)")
  .option("--source <name>", "Intent catalog prefix / query source (default: the data file's basename)")
  .option("--name <name>", "package.json name (default: the output directory's basename)")
  .option("--table <name>", "SQLite table to read (default: the first user table)")
  .option("--no-install", "Skip npm install")
  .option(
    "--mcp",
    "Also generate the MCP front door (stdio + Streamable HTTP servers, for Claude Desktop / claude.ai / ChatGPT)",
  )
  .action(
    async (opts: {
      from: string;
      out?: string;
      source?: string;
      name?: string;
      table?: string;
      install: boolean;
      mcp?: boolean;
    }) => {
      const { formatInitResult, initProject } = await import("./init/index.js");
      let result: InitResult;
      try {
        result = await initProject(opts);
      } catch (e) {
        fail(program, e);
      }
      console.log(formatInitResult(result, opts));
    },
  );

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
    const { formatSmokeL2Output, parseSmokeL2Input, runSmokeL2 } = await import("./commands.js");
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

const component = program.command("component").description("Operations on component packages");

component
  .command("validate")
  .argument("<file>", "JSON file of a ComponentDefinition")
  .description("Validate a component definition (JSON-serialized form)")
  .action(async (file: string) => {
    const { validateComponentFile } = await import("./commands.js");
    const issues = validateComponentFile(file);
    if (issues.length === 0) {
      console.log(`✓ ${file} is a valid ComponentDefinition`);
      return;
    }
    console.log(`✗ ${file} has ${issues.length} issue(s):`);
    for (const issue of issues) console.log(`  - ${issue.field}: ${issue.message}`);
    process.exitCode = 1;
  });

component
  .command("publish")
  .description("(unimplemented) Publish a component to the federated registry")
  .action(() => {
    // "v0.2" refers to the protocol-envelope version (published, feature-gated), so keep the wording
    // distinct to avoid conflating it with an implementation milestone. Federated distribution is unimplemented in every current version.
    console.error(
      "component publish is planned for a future implementation milestone (federated distribution is unimplemented)",
    );
    process.exitCode = 1;
  });

registerDataset(program);

registerEvidence(program);

registerUsage(program);

registerMigrate(program);

await program.parseAsync();

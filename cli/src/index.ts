#!/usr/bin/env node
import { basename } from "node:path";
import type { ConformanceReport } from "@kohaku-ui/spec/conformance";
import { Command } from "commander";
import {
  type ExportDatasetResult,
  exportDataset,
  formatReport,
  parseSmokeL2Input,
  runRestConformance,
  runSelfConformance,
  runSmokeL2,
  type SmokeL2Output,
  scaffoldGolden,
  scaffoldPorts,
  validateComponentFile,
} from "./commands.js";
import { type InitResult, initProject } from "./init/index.js";
import { CLI_VERSION } from "./version.js";

/** Reads stdin to completion and returns it as a string (the smoke-l2 sidecar's one-request-one-process contract). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const program = new Command("kohaku")
  .description("CLI for running Kohaku Protocol conformance checks and generating scaffolds")
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
    let report: ConformanceReport;
    try {
      report =
        opts.rest != null ? await runRestConformance(opts.rest, opts.intent) : await runSelfConformance();
    } catch (e) {
      // Show a malformed --intent shape or a network failure as a single line rather than a stack trace.
      // program.error calls process.exit internally, so this return is never reached at runtime.
      // However, the type system does not learn that process.exit is `never`, and without the return
      // report could be undefined downstream, so we keep the return purely to satisfy the types.
      program.error(e instanceof Error ? e.message : String(e));
      return;
    }
    console.log(formatReport(report));
    process.exitCode = report.pass ? 0 : 1;
  });

program
  .command("scaffold")
  .argument("<what>", '"ports" or "golden"')
  .option("--out <dir>", "Output directory (default depends on the target)")
  .description("Generate scaffolds for product-side Port implementations / Golden regression tests")
  .action((what: string, opts: { out?: string }) => {
    // Switch the default output directory and the post-generation "next steps" per target.
    const targets: Record<string, { defaultOut: string; scaffold: (out: string) => string[]; next: string }> =
      {
        ports: {
          defaultOut: "./kohaku-ports",
          scaffold: scaffoldPorts,
          next: "Implement the TODOs in ports.ts and start server.ts.",
        },
        golden: {
          defaultOut: "./kohaku-golden",
          scaffold: scaffoldGolden,
          next: "Wire up makeContext in golden.test.ts, add *.json files under golden/, then generate the expected specs with KOHAKU_GOLDEN_UPDATE=1.",
        },
      };
    const target = targets[what];
    if (target == null) program.error(`Unknown scaffold target: ${what} (allowed: ports / golden)`);
    let written: string[];
    try {
      written = target!.scaffold(opts.out ?? target!.defaultOut);
    } catch (e) {
      // As with the conformance action, show failures such as existing-file collisions as a single line (no raw stack).
      program.error(e instanceof Error ? e.message : String(e));
      return; // The type of `written` must be settled (process.exit of program.error cannot be conveyed to the types).
    }
    console.log("Generated:");
    for (const path of written) console.log(`  ${path}`);
    console.log(`\nNext steps: ${target!.next}`);
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
  .action(
    async (opts: {
      from: string;
      out?: string;
      source?: string;
      name?: string;
      table?: string;
      install: boolean;
    }) => {
      let result: InitResult;
      try {
        result = await initProject(opts);
      } catch (e) {
        program.error(e instanceof Error ? e.message : String(e));
        return;
      }
      const p = result.profile;
      console.log(`Generated ${result.written.length} files in ${result.outDir}`);
      if (opts.name == null && result.name !== basename(result.outDir)) {
        console.log(
          `  name: ${result.name} (derived from directory "${basename(result.outDir)}"; pass --name to override)`,
        );
      }
      console.log(`  source: ${p.source} (${p.rowCount} rows)`);
      console.log(`  dimensions: ${p.dimensions.map((c) => c.name).join(", ")}`);
      console.log(`  measures: ${p.measures.map((c) => c.name).join(", ") || "(none; row counts only)"}`);
      console.log(`  time: ${p.time?.name ?? "(none; no trend view)"}`);
      console.log(
        `\nNext steps: ${result.installed ? "" : "npm install && "}npm run dev  →  http://localhost:5173`,
      );
      console.log("For chat and the LLM-composed views, copy .env.example to .env and set a provider key.");
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
      process.stderr.write(
        `smoke-l2: failed to read stdin (${e instanceof Error ? e.message : String(e)})\n`,
      );
      process.exitCode = 1;
      return;
    }
    let output: SmokeL2Output;
    try {
      output = await runSmokeL2(parseSmokeL2Input(raw));
    } catch (e) {
      process.stderr.write(`smoke-l2: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify(output)}\n`);
  });

const component = program.command("component").description("Operations on component packages");

component
  .command("validate")
  .argument("<file>", "JSON file of a ComponentDefinition")
  .description("Validate a component definition (JSON-serialized form)")
  .action((file: string) => {
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

const dataset = program.command("dataset").description("Operations on distillation datasets");

dataset
  .command("export")
  .description(
    "Export fixated (and optionally golden) Specs as a JSONL distillation dataset " +
      "(one canonical-JSON line per Spec: {intent, refs, shape?, target: {components, events}, source, meta})",
  )
  .requiredOption(
    "--fixations <path>",
    "fixations.json snapshot ({key -> FixationRecord}; sample-api's .data/fixations.json can be passed directly)",
  )
  .option(
    "--golden <dir>",
    "Directory of golden fixture JSON files ({name, input, drafts, expected}) or plain UISpec JSON files",
  )
  .option(
    "--tenant <id>",
    "Restrict the export to this tenant's fixations. Without it, the output spans every tenant present in --fixations",
  )
  .requiredOption("--out <path>", "Output JSONL file path")
  .action((opts: { fixations: string; golden?: string; tenant?: string; out: string }) => {
    let result: ExportDatasetResult;
    try {
      result = exportDataset({
        fixationsPath: opts.fixations,
        ...(opts.golden != null ? { goldenDir: opts.golden } : {}),
        ...(opts.tenant != null ? { tenant: opts.tenant } : {}),
        outPath: opts.out,
      });
    } catch (e) {
      program.error(e instanceof Error ? e.message : String(e));
      return;
    }
    console.log(
      `Wrote ${result.fixations + result.golden} record(s) (fixations=${result.fixations}, golden=${result.golden}, skipped=${result.skipped}) to ${result.outPath}`,
    );
  });

await program.parseAsync();

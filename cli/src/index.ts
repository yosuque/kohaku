#!/usr/bin/env node
import type { ExplainReport } from "@kohaku-ui/client";
import type { VerifyEvidencePackResult } from "@kohaku-ui/lineage";
import type { ConformanceReport } from "@kohaku-ui/spec/conformance";
import { Command } from "commander";
import { register as registerMigrate } from "./cli/migrate.js";
import {
  addLineageSourceOptions,
  errorMessage,
  exitUsageErrorAsTwo,
  fail,
  headerOption,
  lineageSourceArgs,
} from "./cli/shared.js";
import { register as registerUsage } from "./cli/usage.js";
import type { ExportDatasetResult, SmokeL2Output } from "./commands.js";
import type { EvidenceExportResult, EvidenceKeygenResult } from "./evidence/index.js";
import type { InitResult } from "./init/index.js";
import type { LineageSourceCliOptions } from "./lineage-window.js";
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
  .action(async (opts: { fixations: string; golden?: string; tenant?: string; out: string }) => {
    const { exportDataset, formatDatasetExportResult } = await import("./commands.js");
    let result: ExportDatasetResult;
    try {
      result = exportDataset({
        fixationsPath: opts.fixations,
        ...(opts.golden != null ? { goldenDir: opts.golden } : {}),
        ...(opts.tenant != null ? { tenant: opts.tenant } : {}),
        outPath: opts.out,
      });
    } catch (e) {
      fail(program, e);
    }
    console.log(formatDatasetExportResult(result));
  });

const evidence = program
  .command("evidence")
  .description(
    "Operations on Compliance Evidence Packs (design.md #67) -- see docs/user-guide.md for the EU AI Act " +
      "Article 50 disclosure-evidence context (not legal advice)",
  );

evidence
  .command("keygen")
  .description("Generate a fresh Ed25519 keypair for signing/verifying evidence packs")
  .requiredOption(
    "--out-dir <dir>",
    "Output directory for the generated key files (mode 0600 on the private key)",
  )
  .option(
    "--force",
    "Overwrite an existing key file (permanently invalidates every pack signed with the old key)",
  )
  .action(async (opts: { outDir: string; force?: boolean }) => {
    const { formatEvidenceKeygenResult, runEvidenceKeygen } = await import("./evidence/index.js");
    let result: EvidenceKeygenResult;
    try {
      result = await runEvidenceKeygen(opts.outDir, { force: opts.force === true });
    } catch (e) {
      fail(program, e);
    }
    console.log(formatEvidenceKeygenResult(result));
  });

addLineageSourceOptions(
  evidence
    .command("export")
    .exitOverride(exitUsageErrorAsTwo)
    .description(
      "Assemble and sign a Compliance Evidence Pack from a local StoragePort data directory or a REST host",
    ),
  {
    rest:
      "Read over REST from a running host (mutually exclusive with --data-dir). The pack is ALWAYS " +
      "incomplete (complete: false, fixations.jsonl empty) by design: GET /fixations cannot supply full " +
      "fixation records. Use --data-dir (or a direct StoragePort) for a complete pack",
    tenant:
      "Restrict the export to this tenant. In --rest mode this must match the x-kohaku-tenant --header " +
      "(the header is what actually scopes the request); omit --tenant to have it derived from the header",
    since:
      "Inclusive lower bound of the exported lineage window: a date (YYYY-MM-DD, start of that UTC day) " +
      "or a timestamp with a Z / ±hh:mm offset",
    until:
      "Inclusive upper bound of the exported lineage window: a date (YYYY-MM-DD, which INCLUDES that whole " +
      "UTC day) or a timestamp with a Z / ±hh:mm offset",
  },
)
  .requiredOption("--private-key <pem>", "Path to a PEM-encoded Ed25519 private key (PKCS8)")
  .requiredOption("--out <dir>", "Output directory for the pack")
  .option(
    "--allow-incomplete",
    "Fall back to a bounded lineage read (and mark the pack incomplete) when exhaustive paging is unsupported",
  )
  .action(
    async (
      opts: LineageSourceCliOptions & { privateKey: string; out: string; allowIncomplete?: boolean },
    ) => {
      const { formatEvidenceExportResult, runEvidenceExport } = await import("./evidence/index.js");
      const { CliUsageError } = await import("./usage-error.js");
      let result: EvidenceExportResult;
      try {
        result = await runEvidenceExport({
          ...lineageSourceArgs(opts),
          privateKeyPath: opts.privateKey,
          outDir: opts.out,
          allowIncomplete: opts.allowIncomplete === true,
        });
      } catch (e) {
        // A bad --since / --until is a usage error (exit 2, like `evidence verify`); anything else is 1.
        fail(program, e, e instanceof CliUsageError ? 2 : 1);
      }
      console.log(formatEvidenceExportResult(result));
    },
  );

evidence
  .command("verify")
  .exitOverride(exitUsageErrorAsTwo)
  .argument("<dir>", "Evidence pack directory")
  .description("Verify a Compliance Evidence Pack's signature and file integrity")
  .requiredOption("--public-key <pem>", "Path to a PEM-encoded Ed25519 public key (SPKI)")
  .action(async (dir: string, opts: { publicKey: string }) => {
    // Exit codes: 0 = valid, 1 = invalid, 2 = usage error (bad --public-key, missing/malformed pack
    // directory, and commander's own option errors via exitUsageErrorAsTwo) -- program.error() is not
    // used here since its default exit code (1) would collide with "invalid".
    const { formatEvidenceVerifyResult, runEvidenceVerify } = await import("./evidence/index.js");
    let result: VerifyEvidencePackResult;
    try {
      result = await runEvidenceVerify(dir, opts.publicKey);
    } catch (e) {
      console.error(errorMessage(e));
      process.exitCode = 2;
      return;
    }
    console.log(formatEvidenceVerifyResult(result));
    process.exitCode = result.ok ? 0 : 1;
  });

registerUsage(program);

registerMigrate(program);

await program.parseAsync();

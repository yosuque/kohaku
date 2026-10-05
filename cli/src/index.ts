#!/usr/bin/env node
import { basename } from "node:path";
import type { ExplainReport } from "@kohaku-ui/client";
import type { VerifyEvidencePackResult } from "@kohaku-ui/lineage";
import type { ConformanceReport } from "@kohaku-ui/spec/conformance";
import { Command, type CommanderError } from "commander";
import type { ExportDatasetResult, SmokeL2Output } from "./commands.js";
import type { EvidenceExportResult, EvidenceKeygenResult } from "./evidence/index.js";
import type { InitResult } from "./init/index.js";
import type { MigrateApplyOptions, MigratePlanOptions } from "./migrate.js";
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
  .command("explain")
  .argument(
    "<requestId>",
    "Request id to explain (a compose's X-Request-Id, or an MCP tool call's mcp:... correlation id)",
  )
  .description(
    "Explain why a compose came out the way it did (tier, cache, cache-key breakdown, decision flow, related lineage events)",
  )
  .requiredOption("--rest <baseUrl>", "REST host base URL (e.g. http://localhost:8787/api/kohaku)")
  .option(
    "--header <name:value>",
    "Extra request header, e.g. tenant or auth (repeatable)",
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
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
        program.error(e instanceof Error ? e.message : String(e), {
          exitCode: e instanceof CliUsageError ? 2 : 1,
        });
        return;
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
    // Switch the default output directory and the post-generation "next steps" per target. Validate the target
    // before loading `commands.js` so that a typo does not pay for (or fail on) the heavy module import.
    const targets: Record<string, { defaultOut: string; next: string }> = {
      ports: {
        defaultOut: "./kohaku-ports",
        next: "Implement the TODOs in ports.ts and intents.ts, then start server.ts.",
      },
      golden: {
        defaultOut: "./kohaku-golden",
        next: "Wire up makeContext in golden.test.ts, add *.json files under golden/, then generate the expected specs with KOHAKU_GOLDEN_UPDATE=1.",
      },
    };
    const target = Object.hasOwn(targets, what) ? targets[what] : undefined;
    if (target == null) program.error(`Unknown scaffold target: ${what} (allowed: ports / golden)`);
    const { scaffoldGolden, scaffoldPorts } = await import("./commands.js");
    const scaffold = what === "ports" ? scaffoldPorts : scaffoldGolden;
    let written: string[];
    try {
      written = scaffold(opts.out ?? target!.defaultOut);
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
      const { initProject } = await import("./init/index.js");
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
      if (p.unrecognizedDateColumns != null && p.unrecognizedDateColumns.length > 0) {
        console.log(
          `  warning: column(s) ${p.unrecognizedDateColumns.join(", ")} look like dates but the format ` +
            "is ambiguous (e.g. MM/DD/YYYY vs DD/MM/YYYY), so no time axis was created; convert the column " +
            "to YYYY-MM-DD, the one unambiguous shape kohaku init recognizes, and run it again.",
        );
      }
      console.log(
        `\nNext steps: ${result.installed ? "" : "npm install && "}npm run dev  →  http://localhost:5173`,
      );
      console.log(
        "For chat and the LLM-composed views, edit .env (created for you with a capability secret) " +
          "and set a provider key; .env.example documents every variable.",
      );
      if (!result.installed)
        console.log("KOHAKU_GOLDEN_UPDATE=1 npm test   # once after npm install, then npm test");
      if (opts.mcp === true) {
        console.log(
          "\nMCP front door generated. To use it from Claude Desktop, run: npm run mcp:claude-desktop " +
            "(then restart Claude Desktop). `npm run mcp` (stdio) is the command Claude Desktop / Claude Code / " +
            "Codex CLI launch themselves -- you do not run it by hand. `npm run mcp:http` starts a Streamable HTTP " +
            "server on :8788 for claude.ai / ChatGPT.",
        );
      }
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
    const { parseSmokeL2Input, runSmokeL2 } = await import("./commands.js");
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
    const { exportDataset } = await import("./commands.js");
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

const evidence = program
  .command("evidence")
  .description(
    "Operations on Compliance Evidence Packs (design.md #67) -- see docs/user-guide.md for the EU AI Act " +
      "Article 50 disclosure-evidence context (not legal advice)",
  );

/**
 * `exitOverride` handler for the evidence subcommands whose exit code 1 means "invalid pack" / a runtime
 * failure: commander's own usage errors (a missing required option, an unknown option, a bad argument)
 * default to exit 1 and would collide with it, so they exit 2 instead. `--help` / `--version` carry exit
 * code 0 and stay 0. Commander has already printed the message by the time this runs.
 */
function exitUsageErrorAsTwo(err: CommanderError): never {
  process.exit(err.exitCode === 0 ? 0 : 2);
}

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
    const { runEvidenceKeygen } = await import("./evidence/index.js");
    let result: EvidenceKeygenResult;
    try {
      result = await runEvidenceKeygen(opts.outDir, { force: opts.force === true });
    } catch (e) {
      program.error(e instanceof Error ? e.message : String(e));
      return;
    }
    console.log(`Generated ${result.privateKeyPath} (mode 0600)`);
    console.log(`Generated ${result.publicKeyPath}`);
    console.log(`keyId: ${result.keyId}`);
  });

evidence
  .command("export")
  .exitOverride(exitUsageErrorAsTwo)
  .description(
    "Assemble and sign a Compliance Evidence Pack from a local StoragePort data directory or a REST host",
  )
  .option("--data-dir <dir>", "Read from a local StoragePort data directory (mutually exclusive with --rest)")
  .option(
    "--rest <baseUrl>",
    "Read over REST from a running host (mutually exclusive with --data-dir). The pack is ALWAYS " +
      "incomplete (complete: false, fixations.jsonl empty) by design: GET /fixations cannot supply full " +
      "fixation records. Use --data-dir (or a direct StoragePort) for a complete pack",
  )
  .option(
    "--header <name:value>",
    "Extra REST request header, e.g. tenant or auth (repeatable; --rest only)",
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .option(
    "--tenant <id>",
    "Restrict the export to this tenant. In --rest mode this must match the x-kohaku-tenant --header " +
      "(the header is what actually scopes the request); omit --tenant to have it derived from the header",
  )
  .requiredOption(
    "--since <iso8601>",
    "Inclusive lower bound of the exported lineage window: a date (YYYY-MM-DD, start of that UTC day) " +
      "or a timestamp with a Z / ±hh:mm offset",
  )
  .requiredOption(
    "--until <iso8601>",
    "Inclusive upper bound of the exported lineage window: a date (YYYY-MM-DD, which INCLUDES that whole " +
      "UTC day) or a timestamp with a Z / ±hh:mm offset",
  )
  .requiredOption("--private-key <pem>", "Path to a PEM-encoded Ed25519 private key (PKCS8)")
  .requiredOption("--out <dir>", "Output directory for the pack")
  .option(
    "--allow-incomplete",
    "Fall back to a bounded lineage read (and mark the pack incomplete) when exhaustive paging is unsupported",
  )
  .action(
    async (opts: {
      dataDir?: string;
      rest?: string;
      header: string[];
      tenant?: string;
      since: string;
      until: string;
      privateKey: string;
      out: string;
      allowIncomplete?: boolean;
    }) => {
      const { runEvidenceExport } = await import("./evidence/index.js");
      const { CliUsageError } = await import("./usage-error.js");
      let result: EvidenceExportResult;
      try {
        result = await runEvidenceExport({
          ...(opts.dataDir != null ? { dataDir: opts.dataDir } : {}),
          ...(opts.rest != null ? { rest: opts.rest } : {}),
          headers: opts.header,
          ...(opts.tenant != null ? { tenant: opts.tenant } : {}),
          since: opts.since,
          until: opts.until,
          privateKeyPath: opts.privateKey,
          outDir: opts.out,
          allowIncomplete: opts.allowIncomplete === true,
        });
      } catch (e) {
        // A bad --since / --until is a usage error (exit 2, like `evidence verify`); anything else is 1.
        program.error(e instanceof Error ? e.message : String(e), {
          exitCode: e instanceof CliUsageError ? 2 : 1,
        });
        return;
      }
      const c = result.manifest.counts;
      console.log(`Wrote evidence pack to ${result.outDir}`);
      console.log(
        `  events=${c.events} approvals=${c.approvals} promotions=${c.promotions} fixations=${c.fixations} artifacts=${c.artifacts}` +
          (result.manifest.complete ? "" : " (incomplete)"),
      );
      if (result.manifest.warnings.length > 0) {
        console.log("  warnings:");
        for (const w of result.manifest.warnings) console.log(`    - ${w}`);
      }
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
    const { runEvidenceVerify } = await import("./evidence/index.js");
    let result: VerifyEvidencePackResult;
    try {
      result = await runEvidenceVerify(dir, opts.publicKey);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 2;
      return;
    }
    if (result.ok) {
      console.log("OK: the evidence pack is valid.");
    } else {
      console.log("INVALID:");
      for (const err of result.errors) console.log(`  - ${err}`);
    }
    if (result.mismatches.length > 0) {
      console.log("Non-fatal artifact mismatches:");
      for (const m of result.mismatches) console.log(`  - ${m}`);
    }
    process.exitCode = result.ok ? 0 : 1;
  });

const usage = program
  .command("usage")
  .description("Usage metering derived from the lineage log (design.md #74)");

usage
  .command("export")
  .exitOverride(exitUsageErrorAsTwo)
  .description(
    "Export per-day, per-tenant usage (compositions, cache, tiers, L2 generations, fallbacks, tokens, " +
      "fixations) from the whole lineage log of a local StoragePort data directory or a REST host",
  )
  .option("--data-dir <dir>", "Read from a local StoragePort data directory (mutually exclusive with --rest)")
  .option(
    "--rest <baseUrl>",
    "Read over REST from a running host (mutually exclusive with --data-dir). The x-kohaku-tenant " +
      "--header decides the tenant (export each tenant with its own header); without the header every " +
      "tenant is read (legacy, unscoped hosts)",
  )
  .option(
    "--header <name:value>",
    "Extra REST request header, e.g. tenant or auth (repeatable; --rest only)",
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .option(
    "--tenant <id>",
    "Restrict the export to this tenant (--data-dir; omitted = every tenant, one row per day and tenant). " +
      "In --rest mode this must match the x-kohaku-tenant --header",
  )
  .requiredOption(
    "--since <iso8601>",
    "Inclusive lower bound: a date (YYYY-MM-DD, start of that UTC day) or a timestamp with a Z / ±hh:mm offset",
  )
  .requiredOption(
    "--until <iso8601>",
    "Inclusive upper bound: a date (YYYY-MM-DD, which INCLUDES that whole UTC day) or a timestamp with a Z / ±hh:mm offset",
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
  .action(
    async (opts: {
      dataDir?: string;
      rest?: string;
      header: string[];
      tenant?: string;
      since: string;
      until: string;
      timeoutMs: string;
      format: string;
      out?: string;
    }) => {
      const { CliUsageError } = await import("./usage-error.js");
      const { runUsageExport } = await import("./usage/index.js");
      let result: Awaited<ReturnType<typeof runUsageExport>>;
      try {
        result = await runUsageExport({
          ...(opts.dataDir != null ? { dataDir: opts.dataDir } : {}),
          ...(opts.rest != null ? { rest: opts.rest } : {}),
          headers: opts.header,
          ...(opts.tenant != null ? { tenant: opts.tenant } : {}),
          since: opts.since,
          until: opts.until,
          timeoutMs: Number(opts.timeoutMs),
          format: opts.format as "csv" | "json",
          ...(opts.out != null ? { out: opts.out } : {}),
        });
      } catch (e) {
        // A bad argument (window, format, source, data dir, tenant) is a usage error (exit 2); anything else is 1.
        program.error(e instanceof Error ? e.message : String(e), {
          exitCode: e instanceof CliUsageError ? 2 : 1,
        });
        return;
      }
      if (result.outPath != null) {
        console.error(`Wrote ${result.rows.length} usage row(s) to ${result.outPath}`);
      } else {
        process.stdout.write(result.text);
      }
    },
  );

const migrate = program
  .command("migrate")
  .description("Catalog migration: rewrite fixated Specs off a deprecated part (design.md #65)");

migrate
  .command("plan")
  .description("Compute (read-only) a rewrite plan for every deprecated-with-replacement catalog type")
  .requiredOption(
    "--data-dir <dir>",
    "StoragePort data directory (fixations.json / promotions.json / lineage.jsonl)",
  )
  .requiredOption(
    "--catalog <module>",
    'Path to an ESM module whose default (or named "catalogFor") export is (tenant?: string) => ResolvedCatalog',
  )
  .option(
    "--tenant <id>",
    "Restrict planning to this tenant's fixations (default: the tenant-neutral sweep only)",
  )
  .requiredOption("--out <path>", "Output plan JSON file path")
  .action(async (opts: { dataDir: string; catalog: string; tenant?: string; out: string }) => {
    const options: MigratePlanOptions = {
      dataDir: opts.dataDir,
      catalogModule: opts.catalog,
      outPath: opts.out,
      ...(opts.tenant != null ? { tenant: opts.tenant } : {}),
    };
    const { migratePlan } = await import("./migrate.js");
    let result: Awaited<ReturnType<typeof migratePlan>>;
    try {
      result = await migratePlan(options);
    } catch (e) {
      program.error(e instanceof Error ? e.message : String(e));
      return;
    }
    const { plan } = result;
    console.log(`Wrote ${result.outPath} (planHash: ${plan.planHash})`);
    console.log(
      `  rewrites: ${plan.rewrites.map((r) => `${r.from} -> ${r.to.type}`).join(", ") || "(none)"}`,
    );
    console.log(`  steps: ${plan.steps.length} fixation(s) ready to apply`);
    if (plan.blocked.length > 0) {
      console.log(
        `  blocked: ${plan.blocked.length} fixation(s) failed revalidation and need manual attention:`,
      );
      for (const b of plan.blocked) {
        console.log(
          `    - ${b.intentHash}${b.tenant != null ? ` (tenant: ${b.tenant})` : ""}: ${b.issues.join("; ")}`,
        );
      }
    }
  });

migrate
  .command("apply")
  .description(
    "Commit a previously computed plan's steps. IMPORTANT: stop any host process sharing --data-dir " +
      "first — apply writes through a file-backed StoragePort that is not safe for concurrent writers.",
  )
  .requiredOption("--plan <path>", "Plan JSON file produced by `migrate plan`")
  .requiredOption(
    "--approver <id>",
    "Principal id recorded as the approver on each intent.migrated audit event",
  )
  .requiredOption(
    "--data-dir <dir>",
    "StoragePort data directory (must match the one --plan was computed against)",
  )
  .requiredOption(
    "--catalog <module>",
    "Path to the *live* catalog module (same contract as `plan`'s --catalog). Every step is refused " +
      "(reported as blocked, nothing written) if this catalog has drifted from the one the plan targeted",
  )
  .action(async (opts: { plan: string; approver: string; dataDir: string; catalog: string }) => {
    const options: MigrateApplyOptions = {
      dataDir: opts.dataDir,
      planPath: opts.plan,
      approver: opts.approver,
      catalogModule: opts.catalog,
    };
    const { migrateApply } = await import("./migrate.js");
    let result: Awaited<ReturnType<typeof migrateApply>>;
    try {
      result = await migrateApply(options);
    } catch (e) {
      program.error(e instanceof Error ? e.message : String(e));
      return;
    }
    console.log(
      `Applied ${result.applied.length}, skipped ${result.skipped.length}, blocked ${result.blocked.length}`,
    );
    for (const a of result.applied)
      console.log(`  applied: ${a.intentHash}${a.tenant != null ? ` (tenant: ${a.tenant})` : ""}`);
    for (const s of result.skipped) {
      console.log(
        `  skipped: ${s.intentHash}${s.tenant != null ? ` (tenant: ${s.tenant})` : ""} (fixation changed since the plan was computed)`,
      );
    }
    for (const b of result.blocked) {
      console.log(
        `  blocked: ${b.intentHash}${b.tenant != null ? ` (tenant: ${b.tenant})` : ""} (catalog drift — ` +
          `live fingerprint ${b.observedCatalogFingerprint}${b.issues.length > 0 ? `; ${b.issues.join("; ")}` : ""})`,
      );
    }
    if (result.skipped.length > 0 || result.blocked.length > 0) process.exitCode = 1;
  });

await program.parseAsync();

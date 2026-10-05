import type { VerifyEvidencePackResult } from "@kohaku-ui/lineage";
import type { Command } from "commander";
import type { EvidenceExportResult, EvidenceKeygenResult } from "../evidence/index.js";
import type { LineageSourceCliOptions } from "../lineage-window.js";
import {
  addLineageSourceOptions,
  errorMessage,
  exitUsageErrorAsTwo,
  fail,
  lineageSourceArgs,
} from "./shared.js";

/** Registers `kohaku evidence` (`keygen` / `export` / `verify`). The runner module is loaded lazily by each action. */
export function register(program: Command): void {
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
      const { formatEvidenceKeygenResult, runEvidenceKeygen } = await import("../evidence/index.js");
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
        const { formatEvidenceExportResult, runEvidenceExport } = await import("../evidence/index.js");
        const { CliUsageError } = await import("../usage-error.js");
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
      const { formatEvidenceVerifyResult, runEvidenceVerify } = await import("../evidence/index.js");
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
}

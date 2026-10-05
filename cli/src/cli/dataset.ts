import type { Command } from "commander";
import type { ExportDatasetResult } from "../commands.js";
import { fail } from "./shared.js";

/** Registers `kohaku dataset` (`export`). The runner module is loaded lazily by the action. */
export function register(program: Command): void {
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
      const { exportDataset, formatDatasetExportResult } = await import("../commands.js");
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
}

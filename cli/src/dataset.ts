import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exportDistillationDataset } from "@kohaku-ui/evals";
import { type FixationRecord, FixationRecordSchema, type UISpec, UISpecSchema } from "@kohaku-ui/spec-core";

export interface ExportDatasetOptions {
  /** A fixations.json snapshot (StoragePort's on-disk shape: {key -> FixationRecord}; see storage-port.ts). */
  fixationsPath: string;
  /** A directory of golden fixture JSON files ({name, input, drafts, expected} — see the `scaffold golden` template) or plain UISpec JSON files. */
  goldenDir?: string;
  outPath: string;
  /**
   * Restrict the export to fixations owned by this tenant. Without it, the output spans every tenant
   * present in `fixationsPath` (the on-disk snapshot legitimately holds one record per (tenant,
   * intentHash) for several tenants side by side; see storage-port.ts).
   */
  tenant?: string;
}

export interface ExportDatasetResult {
  fixations: number;
  golden: number;
  outPath: string;
  /** Number of entries in `fixationsPath` that failed FixationRecordSchema and were skipped (see exportDataset's doc comment). */
  skipped: number;
}

/**
 * Reads one golden-fixture-shaped JSON file (`{name, input, drafts, expected}`, from `scaffold golden`) or
 * a plain UISpec JSON file, and returns its Spec. Returns null for a fixture whose `expected` has not been
 * generated yet (`expected: null`) — silently skipped rather than treated as an error, since that is the
 * fixture's normal pre-generation state (see GOLDEN_README_TEMPLATE).
 */
function loadGoldenSpec(path: string): UISpec | null {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const isObject = raw != null && typeof raw === "object" && !Array.isArray(raw);
  const candidate =
    isObject && "expected" in (raw as Record<string, unknown>)
      ? (raw as Record<string, unknown>)["expected"]
      : raw;
  if (candidate == null) return null;
  const parsed = UISpecSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`${path} does not contain a valid UISpec (${parsed.error.message})`);
  }
  return parsed.data;
}

/**
 * dataset export: reads a fixations.json snapshot (sample-api's `.data/fixations.json` can be passed
 * directly) plus optional golden Specs from a directory, and writes the JSONL distillation dataset via
 * @kohaku-ui/evals's exportDistillationDataset (fixated Specs are the best available teacher data
 * for a distilled model, since a human already approved them).
 *
 * Fail-open on a per-entry basis: an entry that fails FixationRecordSchema is skipped (reported on
 * stderr and counted in the result's `skipped`) rather than aborting the whole export. This matches the
 * runtime read path (a record that fails validation is treated as "no fixation", falling back to a fresh
 * compose) — a fail-closed export would otherwise let one hand-edited or pre-migration record block the
 * entire dataset. A top-level shape that is not an object still throws (there is no per-entry recovery
 * from that).
 */
export function exportDataset(options: ExportDatasetOptions): ExportDatasetResult {
  if (!existsSync(options.fixationsPath)) {
    throw new Error(
      `${options.fixationsPath} does not exist. Approve a fixation first (in the sample, it appears under ` +
        `the runtime state directory's fixations.json once one exists).`,
    );
  }
  const rawFixations: unknown = JSON.parse(readFileSync(options.fixationsPath, "utf8"));
  if (rawFixations == null || typeof rawFixations !== "object" || Array.isArray(rawFixations)) {
    throw new Error(
      `${options.fixationsPath} must be a JSON object (the on-disk fixations.json shape: {key -> FixationRecord})`,
    );
  }
  const fixations: FixationRecord[] = [];
  let skipped = 0;
  for (const [key, value] of Object.entries(rawFixations as Record<string, unknown>)) {
    const parsed = FixationRecordSchema.safeParse(value);
    if (!parsed.success) {
      process.stderr.write(
        `dataset export: skipped "${key}" (not a valid FixationRecord: ${parsed.error.message})\n`,
      );
      skipped++;
      continue;
    }
    fixations.push(parsed.data);
  }

  let golden: UISpec[] | undefined;
  if (options.goldenDir != null) {
    golden = [];
    for (const file of readdirSync(options.goldenDir).sort()) {
      if (!file.endsWith(".json")) continue;
      const spec = loadGoldenSpec(join(options.goldenDir, file));
      if (spec != null) golden.push(spec);
    }
  }

  const jsonl = exportDistillationDataset(
    { fixations, ...(golden != null ? { golden } : {}) },
    { tenant: options.tenant },
  );
  const includedFixations =
    options.tenant != null ? fixations.filter((r) => r.tenant === options.tenant).length : fixations.length;
  mkdirSync(dirname(options.outPath), { recursive: true });
  writeFileSync(options.outPath, jsonl);
  return { fixations: includedFixations, golden: golden?.length ?? 0, outPath: options.outPath, skipped };
}

/** The one line `kohaku dataset export` prints after a successful export (the caller does a single `console.log`). */
export function formatDatasetExportResult(result: ExportDatasetResult): string {
  return `Wrote ${result.fixations + result.golden} record(s) (fixations=${result.fixations}, golden=${result.golden}, skipped=${result.skipped}) to ${result.outPath}`;
}

/**
 * `kohaku migrate plan` / `kohaku migrate apply` (design.md #65). Runs the catalog-migration
 * plan/apply cycle (@kohaku-ui/host-core) against a file-backed StoragePort, for the operator flow of
 * "a part was deprecated in my catalog; rewrite every fixated Spec that still uses it onto its
 * replacement."
 *
 * `apply` requires `--catalog` too (the same option `plan` takes): a plan computed against catalog X is
 * not automatically still safe to commit if the catalog has since moved on to Y — `applyCatalogMigration`
 * re-resolves the live catalog per step's tenant and refuses (reports in the result's `blocked`) any step
 * whose target has drifted, rather than trusting the plan blindly.
 *
 * IMPORTANT (documented again in index.ts's --help text): `apply` writes through
 * @kohaku-ui/storage-memory's createFileStoragePort, which loads its snapshot into memory once at
 * construction and is not safe to run concurrently with a live host process sharing the same data
 * directory (StoragePort's own concurrency contract — see ports.ts). Stop the host before running
 * `migrate apply` against its data directory.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyCatalogMigration,
  type CatalogMigrationApplyResult,
  type CatalogMigrationPlan,
  planCatalogMigration,
  verifyCatalogMigrationPlan,
} from "@kohaku-ui/host-core";
import { createFixations, createLineage } from "@kohaku-ui/lineage";
import type { ResolvedCatalog } from "@kohaku-ui/registry";
import { createFileStoragePort } from "@kohaku-ui/storage-memory";

/**
 * Dynamically imports the operator-supplied catalog module and returns its `catalogFor` function.
 * Contract: the module's default export (or a named `catalogFor` export) must be a function
 * `(tenant?: string) => ResolvedCatalog` — exactly `ComposeContext.catalogFor`'s own shape, so a product
 * can point this at the same module it already wires into its host (see app.ts's `buildCatalog`).
 */
async function loadCatalogFor(modulePath: string): Promise<(tenant?: string) => ResolvedCatalog> {
  const absolute = resolve(process.cwd(), modulePath);
  if (!existsSync(absolute)) {
    throw new Error(`--catalog module not found: ${absolute}`);
  }
  let mod: Record<string, unknown>;
  try {
    mod = await import(pathToFileURL(absolute).href);
  } catch (e) {
    // The published CLI runs on plain Node, which cannot load a TypeScript module (or the extensionless
    // imports inside one), and that surfaces as a bare ERR_UNKNOWN_FILE_EXTENSION / ERR_MODULE_NOT_FOUND.
    throw new Error(
      `Cannot import --catalog module ${absolute} (${e instanceof Error ? e.message : String(e)}). ` +
        "The CLI runs on plain Node: if the module is TypeScript, pass a built .js file, or run the CLI " +
        'under tsx, e.g. NODE_OPTIONS="--import tsx" kohaku migrate ...',
      { cause: e },
    );
  }
  const candidate = mod["default"] ?? mod["catalogFor"];
  if (typeof candidate !== "function") {
    throw new Error(
      `${modulePath} must export a default (or named "catalogFor") function: (tenant?: string) => ResolvedCatalog`,
    );
  }
  return candidate as (tenant?: string) => ResolvedCatalog;
}

export interface MigratePlanOptions {
  dataDir: string;
  catalogModule: string;
  tenant?: string;
  outPath: string;
}

export interface MigratePlanResult {
  plan: CatalogMigrationPlan;
  outPath: string;
}

/** `kohaku migrate plan`: read-only. Writes the computed plan as JSON to `outPath`. */
export async function migratePlan(options: MigratePlanOptions): Promise<MigratePlanResult> {
  const catalogFor = await loadCatalogFor(options.catalogModule);
  const storage = createFileStoragePort(options.dataDir);
  const plan = await planCatalogMigration({
    storage,
    catalogFor,
    tenants: options.tenant != null ? [options.tenant] : undefined,
  });
  mkdirSync(dirname(options.outPath), { recursive: true });
  writeFileSync(options.outPath, `${JSON.stringify(plan, null, 2)}\n`);
  return { plan, outPath: options.outPath };
}

export interface MigrateApplyOptions {
  dataDir: string;
  planPath: string;
  approver: string;
  /** Same contract as MigratePlanOptions.catalogModule — MUST resolve the *live* catalog, checked against
   * each step's recorded target fingerprint before anything is written (see applyCatalogMigration's doc). */
  catalogModule: string;
}

/**
 * `kohaku migrate apply`: loads a previously written plan.json, verifies its `planHash` against its own
 * `rewrites`/`steps`/`blocked` content (catching a hand-edited or otherwise corrupted plan file before a
 * single `Fixations.replace` call is made), then commits its `steps` — each independently checked against
 * the *live* catalog (fingerprint match + full re-validation; a step whose target has drifted since
 * planning is refused, reported in the result's `blocked`, and never even reaches `Fixations.replace`) and
 * TOCTOU-guarded against the live *fixation* by `applyCatalogMigration` itself, so a fixation that moved on
 * since planning is skipped rather than clobbered. `createFixations` is wired with the same `catalogFor`,
 * so a successful `replace` re-stamps the fixation's `catalogFingerprint` to the current catalog's — the
 * next serve takes the fast (`fresh`) path instead of an unnecessary revalidation.
 */
export async function migrateApply(options: MigrateApplyOptions): Promise<CatalogMigrationApplyResult> {
  if (!existsSync(options.planPath)) {
    throw new Error(`--plan file not found: ${options.planPath}`);
  }
  const plan = JSON.parse(readFileSync(options.planPath, "utf8")) as CatalogMigrationPlan;
  if (!(await verifyCatalogMigrationPlan(plan))) {
    throw new Error(
      `${options.planPath} failed its integrity check (a recomputed planHash or a step's structure hash does not match the stored one) —` +
        "was it hand-edited? Re-run `kohaku migrate plan` and apply the fresh output.",
    );
  }
  const catalogFor = await loadCatalogFor(options.catalogModule);
  const storage = createFileStoragePort(options.dataDir);
  const lineage = createLineage({ storage });
  const fixations = createFixations({ lineage, storage, catalogFor });
  return applyCatalogMigration({ plan, fixations, approver: { id: options.approver }, catalogFor });
}

/**
 * The text `kohaku migrate plan` prints, as one string with its newlines (the caller does a single
 * `console.log`, which adds the final one): where the plan went, the rewrites, and the fixations that
 * need manual attention.
 */
export function formatMigratePlanResult(result: MigratePlanResult): string {
  const { plan } = result;
  const lines = [
    `Wrote ${result.outPath} (planHash: ${plan.planHash})`,
    `  rewrites: ${plan.rewrites.map((r) => `${r.from} -> ${r.to.type}`).join(", ") || "(none)"}`,
    `  steps: ${plan.steps.length} fixation(s) ready to apply`,
  ];
  if (plan.blocked.length > 0) {
    lines.push(
      `  blocked: ${plan.blocked.length} fixation(s) failed revalidation and need manual attention:`,
    );
    for (const b of plan.blocked) {
      lines.push(
        `    - ${b.intentHash}${b.tenant != null ? ` (tenant: ${b.tenant})` : ""}: ${b.issues.join("; ")}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * The text `kohaku migrate apply` prints: the applied / skipped / blocked tally, then one line per step. The
 * non-zero exit code for a skipped or blocked step stays with the caller.
 */
export function formatMigrateApplyResult(result: CatalogMigrationApplyResult): string {
  const lines = [
    `Applied ${result.applied.length}, skipped ${result.skipped.length}, blocked ${result.blocked.length}`,
  ];
  for (const a of result.applied)
    lines.push(`  applied: ${a.intentHash}${a.tenant != null ? ` (tenant: ${a.tenant})` : ""}`);
  for (const s of result.skipped) {
    lines.push(
      `  skipped: ${s.intentHash}${s.tenant != null ? ` (tenant: ${s.tenant})` : ""} (fixation changed since the plan was computed)`,
    );
  }
  for (const b of result.blocked) {
    lines.push(
      `  blocked: ${b.intentHash}${b.tenant != null ? ` (tenant: ${b.tenant})` : ""} (catalog drift — ` +
        `live fingerprint ${b.observedCatalogFingerprint}${b.issues.length > 0 ? `; ${b.issues.join("; ")}` : ""})`,
    );
  }
  return lines.join("\n");
}

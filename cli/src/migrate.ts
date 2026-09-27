/**
 * `kohaku migrate plan` / `kohaku migrate apply` (design.md #65). Runs the catalog-migration
 * plan/apply cycle (@kohaku-ui/host-core) against a file-backed StoragePort, for the operator flow of
 * "a part was deprecated in my catalog; rewrite every fixated Spec that still uses it onto its
 * replacement."
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
  const mod: Record<string, unknown> = await import(pathToFileURL(absolute).href);
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
}

/**
 * `kohaku migrate apply`: loads a previously written plan.json, verifies its `planHash` against its own
 * `rewrites`/`steps`/`blocked` content (catching a hand-edited or otherwise corrupted plan file before a
 * single `Fixations.replace` call is made), then commits its `steps` — each independently TOCTOU-guarded
 * against the live fixation by `applyCatalogMigration` itself, so a fixation that moved on since planning
 * is skipped rather than clobbered.
 */
export async function migrateApply(options: MigrateApplyOptions): Promise<CatalogMigrationApplyResult> {
  if (!existsSync(options.planPath)) {
    throw new Error(`--plan file not found: ${options.planPath}`);
  }
  const plan = JSON.parse(readFileSync(options.planPath, "utf8")) as CatalogMigrationPlan;
  if (!(await verifyCatalogMigrationPlan(plan))) {
    throw new Error(
      `${options.planPath} failed its integrity check (recomputed planHash does not match the stored one) — ` +
        "was it hand-edited? Re-run `kohaku migrate plan` and apply the fresh output.",
    );
  }
  const storage = createFileStoragePort(options.dataDir);
  const lineage = createLineage({ storage });
  const fixations = createFixations({ lineage, storage });
  return applyCatalogMigration({ plan, fixations, approver: { id: options.approver } });
}

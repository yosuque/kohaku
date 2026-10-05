import type { Command } from "commander";
import type { MigrateApplyOptions, MigratePlanOptions } from "../migrate.js";
import { fail } from "./shared.js";

/** Registers `kohaku migrate` (`plan` / `apply`). The runner module is loaded lazily by each action. */
export function register(program: Command): void {
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
      const { formatMigratePlanResult, migratePlan } = await import("../migrate.js");
      let result: Awaited<ReturnType<typeof migratePlan>>;
      try {
        result = await migratePlan(options);
      } catch (e) {
        fail(program, e);
      }
      console.log(formatMigratePlanResult(result));
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
      const { formatMigrateApplyResult, migrateApply } = await import("../migrate.js");
      let result: Awaited<ReturnType<typeof migrateApply>>;
      try {
        result = await migrateApply(options);
      } catch (e) {
        fail(program, e);
      }
      console.log(formatMigrateApplyResult(result));
      if (result.skipped.length > 0 || result.blocked.length > 0) process.exitCode = 1;
    });
}

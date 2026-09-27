import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixations, createLineage } from "@kohaku-ui/lineage";
import type { UISpec } from "@kohaku-ui/spec-core";
import { createFileStoragePort } from "@kohaku-ui/storage-memory";
import { afterAll, describe, expect, it } from "vitest";
import { migrateApply, migratePlan } from "../src/migrate.js";

const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "kohaku-cli-migrate-"));
  tmpDirs.push(dir);
  return dir;
}

const CATALOG_MODULE = join(import.meta.dirname, "fixtures/migrate-catalog.mjs");
const INTENT_HASH = "sha256:" + "1".repeat(64);

function pinnedSpec(): UISpec {
  return {
    kohaku: "0.1",
    intent: { canonical: "sales.trend", params: {}, hash: INTENT_HASH },
    dataVersion: "v1",
    components: [{ id: "list1", type: "sales.legacyList", props: {}, data: { $ref: "query://sales/list" } }],
    events: [],
    provenance: { tier: "L0", composedBy: "fixture", cache: "fixated" },
  };
}

/** Seeds a fixation referencing the deprecated fixture type via the real Fixations service (so
 * structureHash/revision are computed exactly the way the running system would produce them). */
async function seedFixation(dataDir: string): Promise<void> {
  const storage = createFileStoragePort(dataDir);
  const fixations = createFixations({ lineage: createLineage({ storage }), storage });
  await fixations.fixate({ pinnedSpec: pinnedSpec(), approver: { id: "seed" } });
}

describe("kohaku migrate plan", () => {
  it("writes a plan.json with one step rewriting the fixture's deprecated type", async () => {
    const dataDir = tmp();
    await seedFixation(dataDir);
    const outPath = join(tmp(), "plan.json");

    const { plan, outPath: written } = await migratePlan({
      dataDir,
      catalogModule: CATALOG_MODULE,
      outPath,
    });

    expect(written).toBe(outPath);
    expect(existsSync(outPath)).toBe(true);
    expect(plan.rewrites).toEqual([{ from: "sales.legacyList", to: { type: "presentList" } }]);
    expect(plan.blocked).toEqual([]);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.intentHash).toBe(INTENT_HASH);
    expect(plan.steps[0]!.pinnedSpec.components[0]!.type).toBe("presentList");

    const onDisk = JSON.parse(readFileSync(outPath, "utf8"));
    expect(onDisk.planHash).toBe(plan.planHash);
  });

  it("fails with a clear error when --catalog does not exist", async () => {
    const dataDir = tmp();
    await expect(
      migratePlan({
        dataDir,
        catalogModule: join(tmp(), "does-not-exist.mjs"),
        outPath: join(tmp(), "plan.json"),
      }),
    ).rejects.toThrow(/not found/);
  });

  it("fails with a clear error when --catalog does not export a function", async () => {
    const dataDir = tmp();
    const badModule = join(tmp(), "bad-catalog.mjs");
    writeFileSync(badModule, "export default { notAFunction: true };\n");
    await expect(
      migratePlan({ dataDir, catalogModule: badModule, outPath: join(tmp(), "plan.json") }),
    ).rejects.toThrow(/must export a default/);
  });
});

describe("kohaku migrate apply", () => {
  it("applies a plan's steps, rewriting the persisted fixation and recording intent.migrated", async () => {
    const dataDir = tmp();
    await seedFixation(dataDir);
    const planPath = join(tmp(), "plan.json");
    await migratePlan({ dataDir, catalogModule: CATALOG_MODULE, outPath: planPath });

    const result = await migrateApply({ dataDir, planPath, approver: "reviewer-1" });
    expect(result.applied).toEqual([{ intentHash: INTENT_HASH }]);
    expect(result.skipped).toEqual([]);

    // Re-read from a fresh StoragePort instance (a separate process would do exactly this).
    const storage = createFileStoragePort(dataDir);
    const fixation = await storage.getFixation(INTENT_HASH);
    expect(fixation).not.toBeNull();
    expect(fixation!.pinnedSpec.components[0]!.type).toBe("presentList");
    expect(fixation!.approver.id).toBe("reviewer-1");

    const events = await storage.listLineage({ type: ["intent.migrated"] });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload["intentHash"]).toBe(INTENT_HASH);
  });

  it("rejects a plan.json whose planHash was hand-edited (integrity check)", async () => {
    const dataDir = tmp();
    await seedFixation(dataDir);
    const planPath = join(tmp(), "plan.json");
    await migratePlan({ dataDir, catalogModule: CATALOG_MODULE, outPath: planPath });

    const tampered = JSON.parse(readFileSync(planPath, "utf8"));
    tampered.planHash = "sha256:tampered";
    writeFileSync(planPath, JSON.stringify(tampered));

    await expect(migrateApply({ dataDir, planPath, approver: "reviewer-1" })).rejects.toThrow(
      /integrity check/,
    );
  });

  it("reports a step as skipped (not applied) when the fixation changed since the plan was computed", async () => {
    const dataDir = tmp();
    await seedFixation(dataDir);
    const planPath = join(tmp(), "plan.json");
    await migratePlan({ dataDir, catalogModule: CATALOG_MODULE, outPath: planPath });

    // Simulate the fixation moving on after planning: unfixate and re-fixate (fresh revision/structureHash).
    const storage = createFileStoragePort(dataDir);
    const fixations = createFixations({ lineage: createLineage({ storage }), storage });
    await fixations.unfixate(INTENT_HASH, { id: "someone-else" });
    await fixations.fixate({ pinnedSpec: pinnedSpec(), approver: { id: "someone-else" } });

    const result = await migrateApply({ dataDir, planPath, approver: "reviewer-1" });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([{ intentHash: INTENT_HASH }]);
  });

  it("fails with a clear error when --plan does not exist", async () => {
    const dataDir = tmp();
    await expect(
      migrateApply({ dataDir, planPath: join(tmp(), "missing-plan.json"), approver: "reviewer-1" }),
    ).rejects.toThrow(/not found/);
  });
});

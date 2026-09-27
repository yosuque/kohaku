import { coreCatalog, defineComponent, resolveCatalog } from "@kohaku-ui/registry";
import type { FixationRecord, Principal, StoragePort, UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  applyCatalogMigration,
  type CatalogMigrationFixationReplacer,
  type CatalogMigrationPlan,
  planCatalogMigration,
  verifyCatalogMigrationPlan,
} from "../src/catalog-migration.js";

const INTENT_HASH_CLEAN = "sha256:" + "1".repeat(64);
const INTENT_HASH_BLOCKED = "sha256:" + "2".repeat(64);
const INTENT_HASH_UNTOUCHED = "sha256:" + "3".repeat(64);

const OLD_CLEAN_TYPE = "sales.kpiCardOld";
const OLD_BAD_TYPE = "sales.badOld";
const NEW_TYPE = "sales.kpiCardNew";

function fixedSpec(intentHash: string, components: UISpec["components"]): UISpec {
  return {
    kohaku: "0.1",
    intent: { canonical: "sales.trend", params: {}, hash: intentHash },
    dataVersion: "v1",
    components,
    events: [],
    provenance: { tier: "L0", composedBy: "fixture", cache: "fixated" },
  };
}

function fixation(
  overrides: Partial<FixationRecord> & { intentHash: string; pinnedSpec: UISpec },
): FixationRecord {
  return {
    canonical: "sales.trend",
    structureHash: "before-hash",
    fixatedAt: "2026-01-01T00:00:00Z",
    approver: { id: "admin" },
    ...overrides,
  };
}

function stubStorage(fixations: FixationRecord[]): StoragePort {
  return {
    async getSpecCache() {
      return null;
    },
    async putSpecCache() {},
    async appendLineage() {},
    async listLineage() {
      return [];
    },
    async getPromotionState() {
      return null;
    },
    async putPromotionState() {},
    async listPromotionStates() {
      return [];
    },
    async getFixation() {
      return null;
    },
    async putFixation() {},
    async listFixations() {
      return fixations;
    },
  };
}

function newTypeDef() {
  return defineComponent({
    type: NEW_TYPE,
    version: "1.0.0",
    description: "new kpi card",
    propsSchema: z.object({ label: z.string(), format: z.enum(["currency", "percent"]) }),
    capabilities: { events: [], data: "required", children: "none" },
  });
}

function oldCleanTypeDef() {
  return defineComponent({
    type: OLD_CLEAN_TYPE,
    version: "1.0.0",
    description: "old kpi card (migrates cleanly)",
    propsSchema: z.object({ label: z.string() }),
    capabilities: { events: [], data: "required", children: "none" },
    deprecated: { reason: "superseded", replacedBy: { type: NEW_TYPE } },
    migrateProps: (props) => ({ label: props["label"], format: "currency" }),
  });
}

function oldBadTypeDef() {
  return defineComponent({
    type: OLD_BAD_TYPE,
    version: "1.0.0",
    description: "old kpi card (no migrateProps -- ends up missing a required field)",
    propsSchema: z.object({ label: z.string() }),
    capabilities: { events: [], data: "required", children: "none" },
    deprecated: { reason: "superseded", replacedBy: { type: NEW_TYPE } },
    // No migrateProps: props stay {label}, which fails NEW_TYPE's required `format`.
  });
}

const migrationCatalog = () =>
  resolveCatalog(coreCatalog, { components: [newTypeDef(), oldCleanTypeDef(), oldBadTypeDef()] });

function cleanFixation(): FixationRecord {
  return fixation({
    intentHash: INTENT_HASH_CLEAN,
    pinnedSpec: fixedSpec(INTENT_HASH_CLEAN, [
      {
        id: "kpi1",
        type: OLD_CLEAN_TYPE,
        props: { label: "Revenue" },
        data: { $ref: "query://sales/revenue" },
      },
    ]),
    structureHash: "clean-before",
    revision: "rev-clean",
  });
}

function blockedFixation(): FixationRecord {
  return fixation({
    intentHash: INTENT_HASH_BLOCKED,
    pinnedSpec: fixedSpec(INTENT_HASH_BLOCKED, [
      { id: "kpi2", type: OLD_BAD_TYPE, props: { label: "Cost" }, data: { $ref: "query://sales/cost" } },
    ]),
    structureHash: "blocked-before",
  });
}

function untouchedFixation(): FixationRecord {
  return fixation({
    intentHash: INTENT_HASH_UNTOUCHED,
    pinnedSpec: fixedSpec(INTENT_HASH_UNTOUCHED, [{ id: "root", type: "layout.stack", props: {} }]),
  });
}

describe("planCatalogMigration", () => {
  it("rewrites a fixation whose node references a deprecated type with a working migrateProps", async () => {
    const catalog = migrationCatalog();
    const storage = stubStorage([cleanFixation()]);
    const plan = await planCatalogMigration({ storage, catalogFor: () => catalog });

    expect(plan.steps).toHaveLength(1);
    const step = plan.steps[0]!;
    expect(step.intentHash).toBe(INTENT_HASH_CLEAN);
    expect(step.rewrittenNodeIds).toEqual(["kpi1"]);
    expect(step.beforeStructureHash).toBe("clean-before");
    expect(step.beforeRevision).toBe("rev-clean");
    const rewritten = step.pinnedSpec.components.find((c) => c.id === "kpi1")!;
    expect(rewritten.type).toBe(NEW_TYPE);
    expect(rewritten.props).toEqual({ label: "Revenue", format: "currency" });
    expect(step.afterStructureHash).not.toBe(step.beforeStructureHash);
    expect(plan.blocked).toEqual([]);
  });

  it("reports a revalidation failure in blocked, never in steps", async () => {
    const catalog = migrationCatalog();
    const storage = stubStorage([blockedFixation()]);
    const plan = await planCatalogMigration({ storage, catalogFor: () => catalog });

    expect(plan.steps).toEqual([]);
    expect(plan.blocked).toHaveLength(1);
    const blocked = plan.blocked[0]!;
    expect(blocked.intentHash).toBe(INTENT_HASH_BLOCKED);
    expect(blocked.types).toEqual([OLD_BAD_TYPE]);
    expect(blocked.issues.length).toBeGreaterThan(0);
    expect(blocked.issues[0]).toContain("kpi2:");
  });

  it("skips a fixation that references no deprecated type entirely (not in steps or blocked)", async () => {
    const catalog = migrationCatalog();
    const storage = stubStorage([untouchedFixation()]);
    const plan = await planCatalogMigration({ storage, catalogFor: () => catalog });
    expect(plan.steps).toEqual([]);
    expect(plan.blocked).toEqual([]);
  });

  it("rewrites lists every deprecated-with-replacement type found, even ones with zero matching fixations", async () => {
    const catalog = migrationCatalog();
    const storage = stubStorage([]);
    const plan = await planCatalogMigration({ storage, catalogFor: () => catalog });
    expect(plan.rewrites.sort((a, b) => a.from.localeCompare(b.from))).toEqual([
      { from: OLD_BAD_TYPE, to: { type: NEW_TYPE } },
      { from: OLD_CLEAN_TYPE, to: { type: NEW_TYPE } },
    ]);
  });

  it("`types` narrows planning to only the requested deprecated types", async () => {
    const catalog = migrationCatalog();
    const storage = stubStorage([cleanFixation(), blockedFixation()]);
    const plan = await planCatalogMigration({ storage, catalogFor: () => catalog, types: [OLD_CLEAN_TYPE] });
    expect(plan.rewrites).toEqual([{ from: OLD_CLEAN_TYPE, to: { type: NEW_TYPE } }]);
    expect(plan.steps).toHaveLength(1);
    expect(plan.blocked).toEqual([]); // OLD_BAD_TYPE was never in scope, so its fixation isn't even attempted
  });

  it("planHash is deterministic for identical input and changes when the plan's content changes", async () => {
    const catalog = migrationCatalog();
    const a = await planCatalogMigration({
      storage: stubStorage([cleanFixation()]),
      catalogFor: () => catalog,
    });
    const b = await planCatalogMigration({
      storage: stubStorage([cleanFixation()]),
      catalogFor: () => catalog,
    });
    expect(a.planHash).toBe(b.planHash);
    expect(a.planHash).toMatch(/^sha256:/);

    const c = await planCatalogMigration({
      storage: stubStorage([cleanFixation(), blockedFixation()]),
      catalogFor: () => catalog,
    });
    expect(c.planHash).not.toBe(a.planHash);
  });

  it("sweeps every tenant, tagging steps/blocked with their own tenant", async () => {
    const catalog = migrationCatalog();
    const acmeFixation = { ...cleanFixation(), tenant: "acme" };
    const storage: StoragePort = {
      ...stubStorage([]),
      async listFixations(tenant) {
        return tenant === "acme" ? [acmeFixation] : [];
      },
    };
    const plan = await planCatalogMigration({
      storage,
      catalogFor: () => catalog,
      tenants: [undefined, "acme"],
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.tenant).toBe("acme");
  });
});

describe("verifyCatalogMigrationPlan", () => {
  it("a freshly computed plan verifies", async () => {
    const catalog = migrationCatalog();
    const plan = await planCatalogMigration({
      storage: stubStorage([cleanFixation()]),
      catalogFor: () => catalog,
    });
    expect(await verifyCatalogMigrationPlan(plan)).toBe(true);
  });

  it("a plan whose planHash was hand-edited fails verification", async () => {
    const catalog = migrationCatalog();
    const plan = await planCatalogMigration({
      storage: stubStorage([cleanFixation()]),
      catalogFor: () => catalog,
    });
    expect(await verifyCatalogMigrationPlan({ ...plan, planHash: "sha256:tampered" })).toBe(false);
  });

  it("a plan whose step content was hand-edited (without updating planHash) fails verification", async () => {
    const catalog = migrationCatalog();
    const plan = await planCatalogMigration({
      storage: stubStorage([cleanFixation()]),
      catalogFor: () => catalog,
    });
    const tampered: CatalogMigrationPlan = {
      ...plan,
      steps: plan.steps.map((s) => ({ ...s, afterStructureHash: "sha256:tampered" })),
    };
    expect(await verifyCatalogMigrationPlan(tampered)).toBe(false);
  });

  it("surviving a round-trip through JSON.stringify/parse (as migrate apply reads plan.json) still verifies", async () => {
    const catalog = migrationCatalog();
    const plan = await planCatalogMigration({
      storage: stubStorage([cleanFixation()]),
      catalogFor: () => catalog,
    });
    const roundTripped = JSON.parse(JSON.stringify(plan)) as CatalogMigrationPlan;
    expect(await verifyCatalogMigrationPlan(roundTripped)).toBe(true);
  });
});

describe("applyCatalogMigration", () => {
  const APPROVER: Principal = { id: "reviewer-1" };

  function fakeReplacer(returnsNullFor: Set<string> = new Set()) {
    const calls: {
      intentHash: string;
      pinnedSpec: UISpec;
      options: Parameters<CatalogMigrationFixationReplacer["replace"]>[2];
    }[] = [];
    const replacer: CatalogMigrationFixationReplacer = {
      async replace(intentHash, pinnedSpec, options) {
        calls.push({ intentHash, pinnedSpec, options });
        if (returnsNullFor.has(intentHash)) return null;
        return {
          intentHash,
          canonical: "sales.trend",
          structureHash: "after-hash",
          pinnedSpec,
          fixatedAt: "2026-02-01T00:00:00Z",
          approver: options.approver,
          ...(options.tenant != null ? { tenant: options.tenant } : {}),
        };
      },
    };
    return { replacer, calls };
  }

  async function buildPlan(): Promise<CatalogMigrationPlan> {
    const catalog = migrationCatalog();
    return planCatalogMigration({ storage: stubStorage([cleanFixation()]), catalogFor: () => catalog });
  }

  it("calls replace with the step's guard (structureHash/revision/fixatedAt) and the plan's planHash as planId", async () => {
    const plan = await buildPlan();
    const { replacer, calls } = fakeReplacer();

    const result = await applyCatalogMigration({ plan, fixations: replacer, approver: APPROVER });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.intentHash).toBe(INTENT_HASH_CLEAN);
    expect(call.pinnedSpec).toBe(plan.steps[0]!.pinnedSpec);
    expect(call.options.approver).toBe(APPROVER);
    expect(call.options.planId).toBe(plan.planHash);
    expect(call.options.guard).toEqual({
      ifRevision: "rev-clean",
      ifFixatedAt: "2026-01-01T00:00:00Z",
      ifStructureHash: "clean-before",
    });
    expect(result.applied).toEqual([{ intentHash: INTENT_HASH_CLEAN }]);
    expect(result.skipped).toEqual([]);
  });

  it("reports a step whose replace() returned null (guard mismatch) as skipped, not applied", async () => {
    const plan = await buildPlan();
    const { replacer } = fakeReplacer(new Set([INTENT_HASH_CLEAN]));

    const result = await applyCatalogMigration({ plan, fixations: replacer, approver: APPROVER });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([{ intentHash: INTENT_HASH_CLEAN }]);
  });

  it("never calls replace for a blocked step (only plan.steps is applied)", async () => {
    const catalog = migrationCatalog();
    const plan = await planCatalogMigration({
      storage: stubStorage([blockedFixation()]),
      catalogFor: () => catalog,
    });
    expect(plan.steps).toEqual([]);
    const { replacer, calls } = fakeReplacer();

    const result = await applyCatalogMigration({ plan, fixations: replacer, approver: APPROVER });
    expect(calls).toEqual([]);
    expect(result).toEqual({ applied: [], skipped: [] });
  });

  it("passes tenant through to replace and back to applied/skipped", async () => {
    const catalog = migrationCatalog();
    const acmeFixation = { ...cleanFixation(), tenant: "acme" };
    const storage: StoragePort = {
      ...stubStorage([]),
      async listFixations(tenant) {
        return tenant === "acme" ? [acmeFixation] : [];
      },
    };
    const plan = await planCatalogMigration({
      storage,
      catalogFor: () => catalog,
      tenants: [undefined, "acme"],
    });
    const { replacer, calls } = fakeReplacer();

    const result = await applyCatalogMigration({ plan, fixations: replacer, approver: APPROVER });
    expect(calls[0]!.options.tenant).toBe("acme");
    expect(result.applied).toEqual([{ intentHash: INTENT_HASH_CLEAN, tenant: "acme" }]);
  });
});

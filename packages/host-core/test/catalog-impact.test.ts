import { type ComponentDefinition, coreCatalog, defineComponent, resolveCatalog } from "@kohaku-ui/registry";
import type { FixationRecord, PromotionState, StoragePort, UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { analyzeCatalogImpact } from "../src/catalog-impact.js";

const INTENT_HASH = "sha256:" + "1".repeat(64);

function fixedSpec(components: UISpec["components"]): UISpec {
  return {
    kohaku: "0.1",
    intent: { canonical: "sales.trend", params: {}, hash: INTENT_HASH },
    dataVersion: "v1",
    components,
    events: [],
    provenance: { tier: "L0", composedBy: "fixture", cache: "fixated" },
  };
}

function fixation(overrides: Partial<FixationRecord> & { pinnedSpec: UISpec }): FixationRecord {
  return {
    intentHash: INTENT_HASH,
    canonical: "sales.trend",
    structureHash: "irrelevant-for-this-test",
    fixatedAt: new Date().toISOString(),
    approver: { id: "admin" },
    ...overrides,
  };
}

function promotionState(overrides: Partial<PromotionState> & { artifactId: string }): PromotionState {
  return {
    status: "in_use",
    updatedAt: new Date().toISOString(),
    data: {},
    ...overrides,
  };
}

/** Storage stub whose fixations/promotionStates are keyed by tenant ("" = tenant-neutral / undefined). */
function stubStorage(
  byTenant: Record<string, { fixations?: FixationRecord[]; promotions?: PromotionState[] }>,
): StoragePort {
  const key = (tenant?: string) => tenant ?? "";
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
    async listPromotionStates(tenant) {
      return byTenant[key(tenant)]?.promotions ?? [];
    },
    async getFixation() {
      return null;
    },
    async putFixation() {},
    async listFixations(tenant) {
      return byTenant[key(tenant)]?.fixations ?? [];
    },
  };
}

const deprecatedType = "sales.kpiCardOld";
const replacementType = "sales.kpiCardNew";

function replacementDef(): ComponentDefinition {
  return defineComponent({
    type: replacementType,
    version: "1.0.0",
    description: "replacement",
    propsSchema: z.object({ label: z.string() }),
    capabilities: { events: [], data: "required", children: "none" },
  });
}

function deprecatedDef(): ComponentDefinition {
  return defineComponent({
    type: deprecatedType,
    version: "1.0.0",
    description: "old kpi card",
    propsSchema: z.object({ label: z.string() }),
    capabilities: { events: [], data: "required", children: "none" },
    deprecated: {
      reason: "superseded by sales.kpiCardNew",
      since: "2026-01-01",
      sunset: "2026-12-31",
      replacedBy: { type: replacementType },
    },
  });
}

const deprecatedCatalog = () =>
  resolveCatalog(coreCatalog, { components: [replacementDef(), deprecatedDef()] });

describe("analyzeCatalogImpact", () => {
  it("returns every list empty when nothing is wrong", async () => {
    const catalog = resolveCatalog(coreCatalog);
    const storage = stubStorage({
      "": {
        fixations: [fixation({ pinnedSpec: fixedSpec([{ id: "root", type: "layout.stack", props: {} }]) })],
        promotions: [
          promotionState({ artifactId: "a1", status: "published", data: { componentType: "layout.stack" } }),
        ],
      },
    });
    const report = await analyzeCatalogImpact({ storage, catalogFor: () => catalog });
    expect(report).toEqual({
      fixationIssues: [],
      deprecatedUsage: [],
      publishedPromotionIssues: [],
      originKitMismatches: [],
    });
  });

  it("fixationIssues: a pinnedSpec referencing an unknown type fails validateAgainstCatalog", async () => {
    const catalog = resolveCatalog(coreCatalog);
    const storage = stubStorage({
      "": {
        fixations: [
          fixation({
            pinnedSpec: fixedSpec([{ id: "root", type: "no.such.type", props: {} }]),
          }),
        ],
      },
    });
    const report = await analyzeCatalogImpact({ storage, catalogFor: () => catalog });
    expect(report.fixationIssues).toHaveLength(1);
    expect(report.fixationIssues[0]!.intentHash).toBe(INTENT_HASH);
    expect(report.fixationIssues[0]!.issues[0]).toContain("root:");
    expect(report.fixationIssues[0]!.issues[0]).toContain("no.such.type");
  });

  it("deprecatedUsage: aggregates fixations and promotions (any status) referencing a deprecated type", async () => {
    const catalog = deprecatedCatalog();
    const storage = stubStorage({
      "": {
        fixations: [
          fixation({
            pinnedSpec: fixedSpec([
              { id: "root", type: "layout.stack", props: {}, children: ["k"] },
              { id: "k", type: deprecatedType, props: { label: "Revenue" }, data: { $ref: "query://x" } },
            ]),
          }),
        ],
        promotions: [
          promotionState({
            artifactId: "candidate-1",
            status: "candidate",
            data: { draft: { componentType: deprecatedType, version: "1.0.0" } },
          }),
        ],
      },
    });
    const report = await analyzeCatalogImpact({ storage, catalogFor: () => catalog });
    expect(report.deprecatedUsage).toHaveLength(1);
    const entry = report.deprecatedUsage[0]!;
    expect(entry.type).toBe(deprecatedType);
    expect(entry.deprecated.reason).toBe("superseded by sales.kpiCardNew");
    expect(entry.deprecated.sunset).toBe("2026-12-31");
    expect(entry.fixations).toEqual([{ intentHash: INTENT_HASH }]);
    expect(entry.promotions).toEqual([{ artifactId: "candidate-1", status: "candidate" }]);
    // A not-yet-published candidate on a deprecated type is not itself a "published promotion issue".
    expect(report.publishedPromotionIssues).toEqual([]);
  });

  it("publishedPromotionIssues: reason 'deprecated' for a published candidate on a deprecated type", async () => {
    const catalog = deprecatedCatalog();
    const storage = stubStorage({
      "": {
        promotions: [
          promotionState({
            artifactId: "pub-1",
            status: "published",
            data: { componentType: deprecatedType },
          }),
        ],
      },
    });
    const report = await analyzeCatalogImpact({ storage, catalogFor: () => catalog });
    expect(report.publishedPromotionIssues).toEqual([
      {
        artifactId: "pub-1",
        componentType: deprecatedType,
        reason: "deprecated",
        deprecated: deprecatedDef().deprecated,
      },
    ]);
  });

  it("publishedPromotionIssues: reason 'removed' for a published candidate whose type no longer resolves at all", async () => {
    const catalog = resolveCatalog(coreCatalog); // no contribution at all -- "vanished.type" never existed here
    const storage = stubStorage({
      "": {
        promotions: [
          promotionState({
            artifactId: "pub-2",
            status: "published",
            data: { componentType: "vanished.type" },
          }),
        ],
      },
    });
    const report = await analyzeCatalogImpact({ storage, catalogFor: () => catalog });
    expect(report.publishedPromotionIssues).toEqual([
      { artifactId: "pub-2", componentType: "vanished.type", reason: "removed" },
    ]);
  });

  it("originKitMismatches: flags a published candidate generated under a different kit than currentKit", async () => {
    const catalog = resolveCatalog(coreCatalog);
    const storage = stubStorage({
      "": {
        promotions: [
          promotionState({
            artifactId: "pub-3",
            status: "published",
            data: { componentType: "layout.stack", origin: { kit: { id: "default", version: "1.0.0" } } },
          }),
          promotionState({
            artifactId: "pub-4",
            status: "published",
            data: { componentType: "layout.stack", origin: { kit: { id: "default", version: "2.0.0" } } },
          }),
        ],
      },
    });
    const report = await analyzeCatalogImpact({
      storage,
      catalogFor: () => catalog,
      currentKit: { id: "default", version: "2.0.0" },
    });
    expect(report.originKitMismatches).toEqual([
      {
        artifactId: "pub-3",
        kit: { id: "default", version: "1.0.0" },
        currentKit: { id: "default", version: "2.0.0" },
      },
    ]);
  });

  it("skips the originKitMismatches check entirely when currentKit is omitted", async () => {
    const catalog = resolveCatalog(coreCatalog);
    const storage = stubStorage({
      "": {
        promotions: [
          promotionState({
            artifactId: "pub-5",
            status: "published",
            data: { componentType: "layout.stack", origin: { kit: { id: "default", version: "1.0.0" } } },
          }),
        ],
      },
    });
    const report = await analyzeCatalogImpact({ storage, catalogFor: () => catalog });
    expect(report.originKitMismatches).toEqual([]);
  });

  it("sweeps every tenant in `tenants`, tagging each finding with its own tenant (undefined omits the field)", async () => {
    const catalog = deprecatedCatalog();
    const storage = stubStorage({
      "": {
        fixations: [
          fixation({
            pinnedSpec: fixedSpec([
              { id: "k", type: deprecatedType, props: { label: "x" }, data: { $ref: "query://x" } },
            ]),
          }),
        ],
      },
      acme: {
        promotions: [
          promotionState({
            artifactId: "acme-1",
            status: "published",
            data: { componentType: deprecatedType },
          }),
        ],
      },
    });
    const report = await analyzeCatalogImpact({
      storage,
      catalogFor: () => catalog,
      tenants: [undefined, "acme"],
    });
    expect(report.deprecatedUsage).toHaveLength(1);
    expect(report.deprecatedUsage[0]!.fixations).toEqual([{ intentHash: INTENT_HASH }]);
    expect(report.deprecatedUsage[0]!.promotions).toEqual([
      { artifactId: "acme-1", tenant: "acme", status: "published" },
    ]);
    expect(report.publishedPromotionIssues).toEqual([
      {
        artifactId: "acme-1",
        tenant: "acme",
        componentType: deprecatedType,
        reason: "deprecated",
        deprecated: deprecatedDef().deprecated,
      },
    ]);
  });
});

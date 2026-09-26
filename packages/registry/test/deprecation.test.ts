import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CatalogConflictError,
  ComponentDefinitionError,
  buildGenerationSchema,
  coreCatalog,
  defineComponent,
  resolveCatalog,
  selectGenerationTypes,
} from "../src/index.js";

function makeReplacement() {
  return defineComponent({
    type: "sales.kpiCardV2",
    version: "1.0.0",
    description: "KPI card v2",
    propsSchema: z.object({ label: z.string() }),
    capabilities: { events: [], data: "required", children: "none" },
  });
}

function makeDeprecated(overrides: Partial<Parameters<typeof defineComponent>[0]["deprecated"]> = {}) {
  return defineComponent({
    type: "sales.kpiCard",
    version: "1.0.0",
    description: "KPI card (old)",
    propsSchema: z.object({ label: z.string() }),
    capabilities: { events: [], data: "required", children: "none" },
    deprecated: {
      reason: "replaced by sales.kpiCardV2",
      replacedBy: { type: "sales.kpiCardV2" },
      ...overrides,
    },
  });
}

describe("defineComponent: deprecated validation", () => {
  it("accepts a well-formed deprecation marker", () => {
    expect(() => makeDeprecated()).not.toThrow();
  });

  it("rejects an empty reason", () => {
    expect(() => makeDeprecated({ reason: "  " })).toThrow(ComponentDefinitionError);
  });

  it("rejects replacedBy referencing itself", () => {
    expect(() =>
      defineComponent({
        type: "sales.kpiCard",
        version: "1.0.0",
        description: "x",
        propsSchema: z.object({}),
        capabilities: { events: [], data: "none", children: "none" },
        deprecated: { reason: "loop", replacedBy: { type: "sales.kpiCard" } },
      }),
    ).toThrow(/cannot reference itself/);
  });

  it("rejects an invalid semver in replacedBy.version", () => {
    expect(() => makeDeprecated({ replacedBy: { type: "sales.kpiCardV2", version: "not-a-version" } })).toThrow(
      /not valid semver/,
    );
  });
});

describe("resolveCatalog: deprecated.replacedBy resolution", () => {
  it("throws when replacedBy.type is not in the merged catalog", () => {
    const deprecated = makeDeprecated();
    expect(() => resolveCatalog(coreCatalog, { components: [deprecated] })).toThrow(CatalogConflictError);
  });

  it("resolves once the replacement is present in the same or another contribution", () => {
    const deprecated = makeDeprecated();
    const replacement = makeReplacement();
    const merged = resolveCatalog(coreCatalog, { components: [replacement, deprecated] });
    expect(merged.get("sales.kpiCard")?.deprecated?.replacedBy?.type).toBe("sales.kpiCardV2");
  });

  it("throws when replacedBy.version is pinned but does not match the resolved version", () => {
    const deprecated = makeDeprecated({ replacedBy: { type: "sales.kpiCardV2", version: "2.0.0" } });
    const replacement = makeReplacement();
    expect(() => resolveCatalog(coreCatalog, { components: [replacement, deprecated] })).toThrow(
      CatalogConflictError,
    );
  });

  it("resolves when replacedBy.version matches the resolved version exactly", () => {
    const deprecated = makeDeprecated({ replacedBy: { type: "sales.kpiCardV2", version: "1.0.0" } });
    const replacement = makeReplacement();
    expect(() =>
      resolveCatalog(coreCatalog, { components: [replacement, deprecated] }),
    ).not.toThrow();
  });
});

describe("deprecated parts drop out of generation but keep validating", () => {
  const deprecated = makeDeprecated();
  const replacement = makeReplacement();
  const catalog = resolveCatalog(coreCatalog, { components: [replacement, deprecated] });

  it("selectGenerationTypes excludes the deprecated type", () => {
    expect(selectGenerationTypes(catalog)).not.toContain("sales.kpiCard");
    expect(selectGenerationTypes(catalog)).toContain("sales.kpiCardV2");
  });

  it("buildGenerationSchema variants exclude the deprecated type even under includeTypes", () => {
    const { jsonSchema } = buildGenerationSchema(catalog, [], { includeTypes: ["sales.kpiCard"] });
    const variants = (jsonSchema as any).properties.components.items.anyOf as any[];
    const types = variants.map((v) => v.properties.type.const as string);
    expect(types).not.toContain("sales.kpiCard");
  });

  it("validate() still accepts an existing Spec node that references the deprecated type", () => {
    const { issues } = catalog.validate([
      { id: "root", type: "layout.stack", props: {}, children: ["k"] },
      { id: "k", type: "sales.kpiCard", props: { label: "Revenue" }, data: { $ref: "query://x" } },
    ]);
    expect(issues).toEqual([]);
  });
});

describe("deprecating a part changes the catalog fingerprint; unrelated parts stay comparable", () => {
  it("fingerprint changes once a part is deprecated, and again differs from a non-deprecated same-shape catalog", () => {
    const replacement = makeReplacement();
    const notDeprecated = defineComponent({
      type: "sales.kpiCard",
      version: "1.0.0",
      description: "KPI card (old)",
      propsSchema: z.object({ label: z.string() }),
      capabilities: { events: [], data: "required", children: "none" },
    });
    const deprecated = makeDeprecated();

    const withoutDeprecation = resolveCatalog(coreCatalog, { components: [replacement, notDeprecated] });
    const withDeprecation = resolveCatalog(coreCatalog, { components: [replacement, deprecated] });
    expect(withDeprecation.fingerprint).not.toBe(withoutDeprecation.fingerprint);
  });

  it("core catalog fingerprint (no deprecated core parts) is unaffected: still 613c927375d8b18a", () => {
    expect(resolveCatalog(coreCatalog).fingerprint).toBe("613c927375d8b18a");
  });
});

describe("migrateProps: a TS-only optional function field", () => {
  it("can be attached to a component definition and invoked directly", () => {
    const def = defineComponent({
      type: "sales.kpiCard",
      version: "1.0.0",
      description: "KPI card (old)",
      propsSchema: z.object({ label: z.string() }),
      capabilities: { events: [], data: "required", children: "none" },
      deprecated: { reason: "renamed field", replacedBy: { type: "sales.kpiCardV2" } },
      migrateProps: (props) => ({ label: props["label"] }),
    });
    expect(def.migrateProps?.({ label: "Revenue", legacyExtra: true })).toEqual({ label: "Revenue" });
  });
});

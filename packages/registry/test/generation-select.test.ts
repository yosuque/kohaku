import { describe, expect, it } from "vitest";
import {
  actionButton,
  buildGenerationSchema,
  coreCatalog,
  presentList,
  presentMetric,
  resolveCatalog,
  selectGenerationTypes,
} from "../src/index.js";

const REF = "query://sales/summary?fy=2026&groupBy=region&q=3";
const catalog = resolveCatalog(coreCatalog);

/** Extracts the list of type consts from the generation schema variants. */
function variantTypes(jsonSchema: unknown): string[] {
  const variants = (jsonSchema as any).properties.components.items.anyOf as any[];
  return variants.map((v) => v.properties.type.const as string).sort();
}

describe("propsSchema of new core parts", () => {
  it("action.button requires label, variant defaults to primary", () => {
    expect(actionButton.propsSchema.safeParse({ label: "Run" }).success).toBe(true);
    expect(actionButton.propsSchema.parse({ label: "Run" })).toMatchObject({ variant: "primary" });
    expect(actionButton.propsSchema.safeParse({ label: "" }).success).toBe(false);
    expect(actionButton.propsSchema.safeParse({ variant: "primary" }).success).toBe(false);
  });

  it("presentMetric requires label/valueColumn, format defaults to number, positiveIsGood defaults to true", () => {
    const parsed = presentMetric.propsSchema.parse({ label: "Sales", valueColumn: "revenue" });
    expect(parsed).toMatchObject({ format: "number", positiveIsGood: true });
    expect(presentMetric.propsSchema.safeParse({ valueColumn: "revenue" }).success).toBe(false);
  });

  it("presentList maxItems is 1..100, emptyText has a default", () => {
    expect(presentList.propsSchema.parse({}).emptyText).toBe("(No data)");
    expect(presentList.propsSchema.safeParse({ maxItems: 0 }).success).toBe(false);
    expect(presentList.propsSchema.safeParse({ maxItems: 101 }).success).toBe(false);
    expect(presentList.propsSchema.safeParse({ maxItems: 50 }).success).toBe(true);
  });
});

describe("buildGenerationSchema candidate filtering (generatorVersion-bump tracked)", () => {
  it("generation:'excluded' layout.tabs / layout.tab do not appear in the variants", () => {
    const { jsonSchema } = buildGenerationSchema(catalog, [REF]);
    const types = variantTypes(jsonSchema);
    expect(types).toContain("presentMetric");
    expect(types).toContain("action.button");
    expect(types).not.toContain("layout.tabs");
    expect(types).not.toContain("layout.tab");
    expect(types).not.toContain("ui.loading");
  });

  it("includeTypes narrows to only those types (+ guardrail union)", () => {
    const { jsonSchema } = buildGenerationSchema(catalog, [REF], {
      includeTypes: ["presentMetric", "text.heading"],
    });
    expect(variantTypes(jsonSchema)).toEqual(
      ["layout.stack", "presentMarkdown", "presentMetric", "text.heading"].sort(),
    );
  });

  it("guardrail: layout.stack / presentMarkdown are always included even if absent from includeTypes", () => {
    const { jsonSchema } = buildGenerationSchema(catalog, [REF], {
      includeTypes: ["presentChart"],
    });
    const types = variantTypes(jsonSchema);
    expect(types).toContain("layout.stack");
    expect(types).toContain("presentMarkdown");
    expect(types).toContain("presentChart");
    expect(types).not.toContain("presentForm");
  });

  it("falls back to all entries when none of includeTypes are in the catalog", () => {
    const full = variantTypes(buildGenerationSchema(catalog, [REF]).jsonSchema);
    const filtered = variantTypes(
      buildGenerationSchema(catalog, [REF], { includeTypes: ["does.not.exist"] }).jsonSchema,
    );
    expect(filtered).toEqual(full);
  });

  it("selectGenerationTypes excludes excluded and reflects includeTypes + guardrail", () => {
    const all = selectGenerationTypes(catalog);
    expect(all).not.toContain("layout.tabs");
    expect(all).toContain("presentList");

    const picked = selectGenerationTypes(catalog, ["action.button"]);
    expect(picked.sort()).toEqual(["action.button", "layout.stack", "presentMarkdown"].sort());
  });
});

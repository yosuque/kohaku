import type { UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import {
  buildGenerationSchema,
  controlSelect,
  coreCatalog,
  negotiate,
  resolveCatalog,
  selectGenerationTypes,
} from "../src/index.js";

const REF = "query://sales/summary?fy=2026&groupBy=region&q=3";
const catalog = resolveCatalog(coreCatalog);

/** Extracts the list of type consts from the generation schema variants. */
function variantTypes(jsonSchema: unknown): string[] {
  const variants = (jsonSchema as any).properties.components.items.anyOf as any[];
  return variants.map((v) => v.properties.type.const as string);
}

/** Cross-filter skeleton Spec using control.select (returned version-resolved for negotiate). */
function crossFilterSpec(): UISpec {
  const base: UISpec = {
    kohaku: "0.2",
    intent: { canonical: "sales.quarterly_summary", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "v1",
    state: { region: "japan" },
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["filter", "kpi"] },
      {
        id: "filter",
        type: "control.select",
        props: {
          label: "Region",
          value: "japan",
          options: [
            { value: "japan", label: "Japan" },
            { value: "europe", label: "Europe" },
          ],
        },
      },
      {
        id: "kpi",
        type: "presentMetric",
        props: { label: "Sales", valueColumn: "revenue" },
        data: {
          $ref: "query://sales/summary?fy=2026&region=japan",
          bind: { region: { $state: "region", values: ["japan", "europe"] } },
        },
      },
    ],
    events: [{ on: "filter.change", emit: "state.set", payload: { key: "region", value: "$value" } }],
    provenance: { tier: "L0", composedBy: "template", cache: "fixated" },
  };
  return { ...base, components: catalog.validate(base.components, base.events).normalized };
}

describe("control.select ComponentDefinition", () => {
  it("registered in the core catalog with capabilities change/data:none/children:none", () => {
    const def = catalog.get("control.select")!;
    expect(def).toBeDefined();
    expect(def.version).toBe("1.0.0");
    expect(def.capabilities).toMatchObject({ events: ["change"], data: "none", children: "none" });
  });

  it("propsSchema: options required (at least 1), value/placeholder/label optional", () => {
    expect(controlSelect.propsSchema.safeParse({ options: ["a", "b"] }).success).toBe(true);
    expect(
      controlSelect.propsSchema.safeParse({ options: [{ value: "a", label: "A" }], value: "a" }).success,
    ).toBe(true);
    expect(controlSelect.propsSchema.safeParse({ options: [] }).success).toBe(false);
    expect(controlSelect.propsSchema.safeParse({}).success).toBe(false);
  });

  it("catalog.validate: control.select with a change event and no data passes", () => {
    const { issues } = catalog.validate(
      [
        { id: "root", type: "layout.stack", props: {}, children: ["f"] },
        { id: "f", type: "control.select", props: { options: ["a", "b"], value: "a" } },
      ],
      [{ on: "f.change", emit: "state.set", payload: { key: "region", value: "$value" } }],
    );
    expect(issues).toEqual([]);
  });

  it("catalog.validate: an undeclared event (press) is EVENT_NOT_SUPPORTED", () => {
    const { issues } = catalog.validate(
      [
        { id: "root", type: "layout.stack", props: {}, children: ["f"] },
        { id: "f", type: "control.select", props: { options: ["a"], value: "a" } },
      ],
      [{ on: "f.press", emit: "action.invoke", payload: {} }],
    );
    expect(issues.map((i) => i.code)).toContain("EVENT_NOT_SUPPORTED");
  });
});

describe("control.select is absent from the L1 generation vocabulary (generation:excluded)", () => {
  it("does not appear in the selectGenerationTypes / buildGenerationSchema variants", () => {
    expect(selectGenerationTypes(catalog)).not.toContain("control.select");
    expect(variantTypes(buildGenerationSchema(catalog, [REF]).jsonSchema)).not.toContain("control.select");
  });
});

describe("control.select negotiate (capability negotiation)", () => {
  it("remains unchanged on a supporting surface", () => {
    const { downgrades } = negotiate(crossFilterSpec(), catalog, {
      supports: {
        "layout.stack": "^1.0.0",
        "control.select": "^1.0.0",
        presentMetric: "^1.0.0",
        presentMarkdown: "^1.0.0",
      },
    });
    expect(downgrades).toEqual([]);
  });

  it("downgrades to the presentMarkdown terminal on an unsupporting surface", () => {
    const { spec: out, downgrades } = negotiate(crossFilterSpec(), catalog, {
      supports: {
        "layout.stack": "^1.0.0",
        presentMetric: "^1.0.0",
        presentMarkdown: "^1.0.0",
        // control.select is not supported
      },
    });
    expect(downgrades.some((d) => d.id === "filter" && d.to === "presentMarkdown")).toBe(true);
    expect(out.components.find((c) => c.id === "filter")?.type).toBe("presentMarkdown");
  });
});

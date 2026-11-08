import {
  collectCapabilityScopes,
  type FilterDescriptor,
  SPEC_VERSION,
  type UISpec,
  validateSpecStructure,
} from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { injectFilters } from "../src/post/inject-filters.js";

const REGION: FilterDescriptor = {
  param: "region",
  queryParam: "geo",
  label: "Region",
  options: [
    { value: "japan", label: "Japan" },
    { value: "europe", label: "Europe" },
    { value: "apac", label: "APAC" },
  ],
};
const GROUP_BY: FilterDescriptor = {
  param: "groupBy",
  queryParam: "groupBy",
  label: "Group by",
  options: [
    { value: "region", label: "By region" },
    { value: "product", label: "By product" },
  ],
};

/** A normalized L1-shaped Spec: root stack with a heading, a chart and a table, both reading `refs`. */
function l1Spec(chartRef: string, tableRef: string = chartRef): UISpec {
  return {
    kohaku: SPEC_VERSION,
    intent: { canonical: "sales.summary", params: {}, hash: "sha256:x" },
    dataVersion: "v1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["title1", "chart1", "table1"] },
      { id: "title1", type: "text.heading", props: { text: "Sales", level: 2 } },
      { id: "chart1", type: "presentChart", props: { kind: "bar" }, data: { $ref: chartRef } },
      { id: "table1", type: "presentSpreadsheet", props: {}, data: { $ref: tableRef } },
    ],
    events: [],
    provenance: { tier: "L1", composedBy: "composer", cache: "miss" },
  };
}

const REF = "query://sales/summary?geo=europe&groupBy=region";

describe("injectFilters", () => {
  it("adds the control, state, change event and bind for a matching param, and the result validates", () => {
    const { spec, injected, skipped } = injectFilters(l1Spec(REF), [REGION]);
    expect(skipped).toBeUndefined();
    expect(injected).toEqual(["region"]);

    // control.select placed first, right after root and first among root's children.
    expect(spec.components[1]).toEqual({
      id: "filter-region",
      type: "control.select",
      props: {
        label: "Region",
        value: "europe",
        options: [
          { value: "japan", label: "Japan" },
          { value: "europe", label: "Europe" },
          { value: "apac", label: "APAC" },
        ],
      },
    });
    expect(spec.components[0]?.children).toEqual(["filter-region", "title1", "chart1", "table1"]);
    expect(spec.state).toEqual({ region: "europe" });
    expect(spec.events).toEqual([
      { on: "filter-region.change", emit: "state.set", payload: { key: "region", value: "$value" } },
    ]);
    const bind = { geo: { $state: "region", values: ["japan", "europe", "apac"] } };
    expect(spec.components.find((c) => c.id === "chart1")?.data).toEqual({ $ref: REF, bind });
    expect(spec.components.find((c) => c.id === "table1")?.data).toEqual({ $ref: REF, bind });
    expect(validateSpecStructure(spec).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("leaves the Spec untouched when no descriptor matches a $ref query param", () => {
    const input = l1Spec("query://sales/summary?groupBy=region");
    const out = injectFilters(input, [REGION]);
    expect(out.injected).toEqual([]);
    expect(out.skipped).toBeUndefined();
    expect(out.spec).toBe(input);
  });

  it("does not inject a param whose current value is not among the options (e.g. cleared)", () => {
    const input = l1Spec("query://sales/summary?geo=mars&groupBy=region");
    const out = injectFilters(input, [REGION, GROUP_BY]);
    // geo=mars is not an authorized value, so only groupBy is injected.
    expect(out.injected).toEqual(["groupBy"]);
    expect(out.spec.state).toEqual({ groupBy: "region" });
    expect(out.spec.components.some((c) => c.id === "filter-region")).toBe(false);
  });

  it("skips everything with variant-limit when the total variant count exceeds 256", () => {
    const big: FilterDescriptor = {
      param: "region",
      queryParam: "geo",
      label: "Region",
      options: Array.from({ length: 130 }, (_, i) => ({ value: i === 0 ? "europe" : `r${i}`, label: `r${i}` })),
    };
    const input = l1Spec(REF);
    // 130 variants per data component x 2 components = 260 > 256.
    const out = injectFilters(input, [big]);
    expect(out.skipped).toBe("variant-limit");
    expect(out.injected).toEqual([]);
    expect(out.spec).toBe(input);
  });

  it("adds one control for a param used by two data components and binds both", () => {
    const other = "query://sales/summary?geo=europe&groupBy=product";
    const out = injectFilters(l1Spec(REF, other), [REGION]);
    expect(out.injected).toEqual(["region"]);
    expect(out.spec.components.filter((c) => c.type === "control.select")).toHaveLength(1);
    expect(out.spec.events.filter((e) => e.emit === "state.set")).toHaveLength(1);
    expect(out.spec.components.find((c) => c.id === "chart1")?.data?.bind).toBeDefined();
    expect(out.spec.components.find((c) => c.id === "table1")?.data?.bind).toBeDefined();
  });

  it("makes collectCapabilityScopes enumerate the read scope of every variant", () => {
    const { spec } = injectFilters(l1Spec(REF), [REGION]);
    const reads = collectCapabilityScopes(spec)
      .filter((s) => s.kind === "read")
      .map((s) => s.ref)
      .sort();
    expect(reads).toEqual([
      "query://sales/summary?geo=apac&groupBy=region",
      "query://sales/summary?geo=europe&groupBy=region",
      "query://sales/summary?geo=japan&groupBy=region",
    ]);
  });

  it("orders several controls by descriptor order and combines their binds (Cartesian product)", () => {
    const { spec, injected } = injectFilters(l1Spec(REF), [GROUP_BY, REGION]);
    expect(injected).toEqual(["groupBy", "region"]);
    expect(spec.components.slice(1, 3).map((c) => c.id)).toEqual(["filter-groupBy", "filter-region"]);
    expect(spec.state).toEqual({ groupBy: "region", region: "europe" });
    // 3 regions x 2 groupBy = 6 variants per data component.
    const reads = collectCapabilityScopes(spec).filter((s) => s.kind === "read");
    expect(reads).toHaveLength(6);
  });

  it("is a no-op for an empty descriptor list", () => {
    const input = l1Spec(REF);
    expect(injectFilters(input, [])).toEqual({ spec: input, injected: [] });
  });

  it("skips a descriptor whose id, state key or event would collide with the Spec's own", () => {
    const withState: UISpec = { ...l1Spec(REF), state: { region: "japan" } };
    expect(injectFilters(withState, [REGION]).injected).toEqual([]);
    const withId = l1Spec(REF);
    withId.components.push({ id: "filter-region", type: "text.heading", props: { text: "x", level: 2 } });
    withId.components[0]!.children = [...withId.components[0]!.children!, "filter-region"];
    expect(injectFilters(withId, [REGION]).injected).toEqual([]);
  });

  it("skips a descriptor when the data components disagree on the current value", () => {
    const out = injectFilters(l1Spec(REF, "query://sales/summary?geo=japan&groupBy=region"), [REGION]);
    expect(out.injected).toEqual([]);
  });

  it("returns invalid (and the input Spec) when the root cannot host controls", () => {
    const input = l1Spec(REF);
    input.components[0] = { id: "root", type: "layout.tabs", props: {}, children: ["title1", "chart1", "table1"] };
    const out = injectFilters(input, [REGION]);
    expect(out.skipped).toBe("invalid");
    expect(out.spec).toBe(input);
  });

  it("does not mutate its input", () => {
    const input = l1Spec(REF);
    const before = JSON.stringify(input);
    injectFilters(input, [REGION, GROUP_BY]);
    expect(JSON.stringify(input)).toBe(before);
  });
});

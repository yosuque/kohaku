import { describe, expect, it } from "vitest";
import { type DataRef, enumerateBindVariants, resolveBoundRef, safeParseSpec } from "../src/index.js";

const INTENT = { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L0", composedBy: "test", cache: "hit" } as const;

/** Builds a bound Spec input (for safeParseSpec). The initial variant of data.$ref is region=japan. */
function bindSpecInput(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kohaku: "0.2",
    intent: INTENT,
    dataVersion: "v1",
    state: { region: "japan" },
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["kpi"] },
      {
        id: "kpi",
        type: "presentMetric",
        props: { label: "Sales", valueColumn: "revenue" },
        data: {
          $ref: "query://sales/summary?fy=2026&groupBy=region&q=3&region=japan",
          bind: { region: { $state: "region", values: ["japan", "north_america", "europe", "apac"] } },
        },
      },
    ],
    events: [],
    provenance: PROVENANCE,
    ...over,
  };
}

const DATA_REF: DataRef = {
  $ref: "query://sales/summary?fy=2026&groupBy=region&q=3&region=japan",
  bind: { region: { $state: "region", values: ["japan", "north_america", "europe", "apac"] } },
};

describe("resolveBoundRef (pure function)", () => {
  it("returns $ref as-is when there is no bind", () => {
    const ref: DataRef = { $ref: "query://sales/summary?fy=2026&region=japan" };
    expect(resolveBoundRef(ref, { region: "europe" })).toBe(ref.$ref);
  });

  it("returns the raw $ref as-is in the initial state (state = initial value) (initial variant)", () => {
    expect(resolveBoundRef(DATA_REF, { region: "japan" })).toBe(DATA_REF.$ref);
  });

  it("keeps the initial value ($ref unchanged) when the key is absent from state", () => {
    expect(resolveBoundRef(DATA_REF, {})).toBe(DATA_REF.$ref);
  });

  it("when state has a different value, replaces the parameter and returns it canonicalized (key sort preserved)", () => {
    expect(resolveBoundRef(DATA_REF, { region: "europe" })).toBe(
      "query://sales/summary?fy=2026&groupBy=region&q=3&region=europe",
    );
  });

  it("the replacement value is stringified (non-string state value into query)", () => {
    const ref: DataRef = {
      $ref: "query://sales/summary?fy=2026&q=3",
      bind: { q: { $state: "quarter", values: ["3", "4"] } },
    };
    expect(resolveBoundRef(ref, { quarter: 4 })).toBe("query://sales/summary?fy=2026&q=4");
  });

  it("replaces only the changed bindings among multiple (unchanged stay at initial value)", () => {
    const ref: DataRef = {
      $ref: "query://sales/kpi?fy=2026&metric=total&region=japan",
      bind: {
        region: { $state: "region", values: ["japan", "europe"] },
        metric: { $state: "metric", values: ["total", "avg"] },
      },
    };
    expect(resolveBoundRef(ref, { region: "europe", metric: "total" })).toBe(
      "query://sales/kpi?fy=2026&metric=total&region=europe",
    );
  });
});

describe("enumerateBindVariants (pure function)", () => {
  it("returns just the canonical form of $ref when there is no bind", () => {
    const variants = enumerateBindVariants({ $ref: "query://s/p?b=2&a=1" });
    expect(variants).toEqual(["query://s/p?a=1&b=2"]);
  });

  it("a single binding enumerates one variant per value and includes the initial variant", () => {
    const variants = enumerateBindVariants(DATA_REF);
    expect(variants).toHaveLength(4);
    expect(variants).toContain("query://sales/summary?fy=2026&groupBy=region&q=3&region=japan");
    expect(variants).toContain("query://sales/summary?fy=2026&groupBy=region&q=3&region=europe");
    // all in canonical form (keys sorted)
    expect(
      variants.every((v) => v.startsWith("query://sales/summary?fy=2026&groupBy=region&q=3&region=")),
    ).toBe(true);
  });

  it("two bindings enumerate the Cartesian product (product of value counts)", () => {
    const ref: DataRef = {
      $ref: "query://sales/kpi?fy=2026&metric=total&region=japan",
      bind: {
        region: { $state: "region", values: ["japan", "europe"] },
        metric: { $state: "metric", values: ["total", "avg"] },
      },
    };
    const variants = enumerateBindVariants(ref);
    expect(variants).toHaveLength(4);
    // includes every combination of the Cartesian product (in canonical form)
    expect(new Set(variants)).toEqual(
      new Set([
        "query://sales/kpi?fy=2026&metric=total&region=japan",
        "query://sales/kpi?fy=2026&metric=avg&region=japan",
        "query://sales/kpi?fy=2026&metric=total&region=europe",
        "query://sales/kpi?fy=2026&metric=avg&region=europe",
      ]),
    );
  });

  it("deduplicates by canonical URI even when values have duplicates or overlap the initial value", () => {
    const ref: DataRef = {
      $ref: "query://s/p?region=japan",
      bind: { region: { $state: "region", values: ["japan", "japan", "europe"] } },
    };
    expect(enumerateBindVariants(ref)).toHaveLength(2);
  });
});

describe("validateSpecStructure: bind validation", () => {
  it("valid: 0.2 + a bind with three-way initial-value agreement passes", () => {
    expect(safeParseSpec(bindSpecInput()).ok).toBe(true);
  });

  it("VERSION_FEATURE_MISMATCH: putting bind on 0.1 is rejected", () => {
    // On 0.1, state itself is also a feature violation, so remove state and trip the feature gate with bind alone.
    const result = safeParseSpec(bindSpecInput({ kohaku: "0.1", state: undefined }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("VERSION_FEATURE_MISMATCH");
  });

  it("BIND_STATE_UNKNOWN: rejected when the $state key has no initial value", () => {
    const result = safeParseSpec(bindSpecInput({ state: {} }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("BIND_STATE_UNKNOWN");
  });

  it("BIND_PARAM_MISSING: rejected when the bound parameter is absent from $ref", () => {
    const result = safeParseSpec(
      bindSpecInput({
        state: { category: "a" },
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["kpi"] },
          {
            id: "kpi",
            type: "presentMetric",
            props: { label: "x", valueColumn: "v" },
            data: {
              $ref: "query://sales/summary?fy=2026&region=japan",
              bind: { category: { $state: "category", values: ["a", "b"] } },
            },
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("BIND_PARAM_MISSING");
  });

  it("BIND_VALUE_INVALID: rejected when the $ref initial value is not in values", () => {
    const result = safeParseSpec(
      bindSpecInput({
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["kpi"] },
          {
            id: "kpi",
            type: "presentMetric",
            props: { label: "x", valueColumn: "v" },
            data: {
              $ref: "query://sales/summary?fy=2026&region=japan",
              bind: { region: { $state: "region", values: ["europe", "apac"] } },
            },
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("BIND_VALUE_INVALID");
  });

  it("BIND_VALUE_INVALID: rejected when the $ref initial value and spec.state initial value disagree (three-way agreement)", () => {
    const result = safeParseSpec(
      bindSpecInput({
        state: { region: "europe" }, // mismatches because $ref is region=japan
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("BIND_VALUE_INVALID");
  });

  it("BIND_PARAM_RESERVED: a bound parameter in the reserved namespace (leading _) is rejected", () => {
    const result = safeParseSpec(
      bindSpecInput({
        state: { limit: "50" },
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["kpi"] },
          {
            id: "kpi",
            type: "presentMetric",
            props: { label: "x", valueColumn: "v" },
            data: {
              $ref: "query://sales/summary?_limit=50&fy=2026",
              bind: { _limit: { $state: "limit", values: ["50", "100"] } },
            },
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("BIND_PARAM_RESERVED");
  });

  it("BIND_VARIANT_LIMIT: rejected when the total variant count exceeds the limit", () => {
    const values = Array.from({ length: 257 }, (_, i) => `v${i}`);
    const result = safeParseSpec(
      bindSpecInput({
        state: { region: "v0" },
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["kpi"] },
          {
            id: "kpi",
            type: "presentMetric",
            props: { label: "x", valueColumn: "v" },
            data: {
              $ref: "query://sales/summary?fy=2026&region=v0",
              bind: { region: { $state: "region", values } },
            },
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("BIND_VARIANT_LIMIT");
  });
});

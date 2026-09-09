import { describe, expect, it } from "vitest";
import {
  applyPatch,
  canonicalStringify,
  collectStateRefs,
  computeStructureHash,
  diffSpec,
  evaluateVisibleWhen,
  MAX_PREDICATE_DEPTH,
  MAX_PREDICATE_ITEMS,
  safeParseSpec,
  sha256Hex,
  type UISpec,
  type VisibleWhen,
  VisibleWhenSchema,
} from "../src/index.js";

const INTENT = { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L0", composedBy: "test", cache: "hit" } as const;

/** Builds a Spec input by swapping in kohaku / state / components / events (for safeParseSpec). */
function specInput(over: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    kohaku: "0.2",
    intent: INTENT,
    dataVersion: "v1",
    components: [{ id: "root", type: "layout.stack", props: {} }],
    events: [],
    provenance: PROVENANCE,
    ...over,
  };
}

describe("VisibleWhen predicate schema", () => {
  it("exactly one of eq / ne / in passes", () => {
    expect(VisibleWhenSchema.safeParse({ ref: "$state.tab", eq: "a" }).success).toBe(true);
    expect(VisibleWhenSchema.safeParse({ ref: "$state.tab", ne: "a" }).success).toBe(true);
    expect(VisibleWhenSchema.safeParse({ ref: "$state.tab", in: ["a", "b"] }).success).toBe(true);
    // comparison against null is also valid (distinguished from undefined = unspecified)
    expect(VisibleWhenSchema.safeParse({ ref: "$state.tab", eq: null }).success).toBe(true);
  });

  it("exactly-one constraint: rejects both 0 and 2", () => {
    expect(VisibleWhenSchema.safeParse({ ref: "$state.tab" }).success).toBe(false);
    expect(VisibleWhenSchema.safeParse({ ref: "$state.tab", eq: "a", ne: "b" }).success).toBe(false);
  });

  it("ref must be in $state.<key> form", () => {
    expect(VisibleWhenSchema.safeParse({ ref: "tab", eq: "a" }).success).toBe(false);
    expect(VisibleWhenSchema.safeParse({ ref: "$state.1bad", eq: "a" }).success).toBe(false);
  });

  it("accepts numeric comparison leaves (gt/lt/gte/lte) and the exists leaf", () => {
    for (const cmp of ["gt", "lt", "gte", "lte"] as const) {
      expect(VisibleWhenSchema.safeParse({ ref: "$state.n", [cmp]: 3 }).success).toBe(true);
    }
    expect(VisibleWhenSchema.safeParse({ ref: "$state.n", exists: true }).success).toBe(true);
    expect(VisibleWhenSchema.safeParse({ ref: "$state.n", exists: false }).success).toBe(true);
    // gt and friends are numeric-only (string comparison values are rejected)
    expect(VisibleWhenSchema.safeParse({ ref: "$state.n", gt: "3" }).success).toBe(false);
  });

  it("the exactly-one constraint extends to new leaves (eq+gt or gt+lt is rejected)", () => {
    expect(VisibleWhenSchema.safeParse({ ref: "$state.n", eq: 1, gt: 0 }).success).toBe(false);
    expect(VisibleWhenSchema.safeParse({ ref: "$state.n", gt: 0, lt: 10 }).success).toBe(false);
  });

  it("accepts compound predicates all / any / not (including nesting)", () => {
    expect(
      VisibleWhenSchema.safeParse({
        all: [
          { ref: "$state.tab", eq: "a" },
          { ref: "$state.n", gte: 3 },
        ],
      }).success,
    ).toBe(true);
    expect(
      VisibleWhenSchema.safeParse({
        any: [{ not: { ref: "$state.tab", eq: "a" } }, { ref: "$state.n", exists: true }],
      }).success,
    ).toBe(true);
    // an empty array is rejected (min 1)
    expect(VisibleWhenSchema.safeParse({ all: [] }).success).toBe(false);
  });

  it("a mix of compound keys and leaf keys is rejected by strict", () => {
    expect(VisibleWhenSchema.safeParse({ ref: "$state.tab", eq: "a", all: [] }).success).toBe(false);
    expect(
      VisibleWhenSchema.safeParse({
        all: [{ ref: "$state.tab", eq: "a" }],
        not: { ref: "$state.tab", eq: "a" },
      }).success,
    ).toBe(false);
  });

  it("rejected when the nesting depth exceeds the limit", () => {
    // stack not to build depth (leaf = depth 1).
    const nest = (depth: number): VisibleWhen => {
      let p: VisibleWhen = { ref: "$state.tab", eq: "a" };
      for (let d = 1; d < depth; d++) p = { not: p };
      return p;
    };
    expect(VisibleWhenSchema.safeParse(nest(MAX_PREDICATE_DEPTH)).success).toBe(true);
    expect(VisibleWhenSchema.safeParse(nest(MAX_PREDICATE_DEPTH + 1)).success).toBe(false);
  });

  it("rejected when the number of all / any elements exceeds the limit", () => {
    const leaf = { ref: "$state.tab", eq: "a" } as const;
    const ok = { all: Array.from({ length: MAX_PREDICATE_ITEMS }, () => leaf) };
    const over = { all: Array.from({ length: MAX_PREDICATE_ITEMS + 1 }, () => leaf) };
    expect(VisibleWhenSchema.safeParse(ok).success).toBe(true);
    expect(VisibleWhenSchema.safeParse(over).success).toBe(false);
  });
});

describe("evaluateVisibleWhen (pure function)", () => {
  it("eq / ne judge by canonicalStringify equivalence", () => {
    expect(evaluateVisibleWhen({ ref: "$state.tab", eq: "a" }, { tab: "a" })).toBe(true);
    expect(evaluateVisibleWhen({ ref: "$state.tab", eq: "a" }, { tab: "b" })).toBe(false);
    expect(evaluateVisibleWhen({ ref: "$state.tab", ne: "a" }, { tab: "b" })).toBe(true);
    // objects with different key order are also equal
    expect(evaluateVisibleWhen({ ref: "$state.o", eq: { a: 1, b: 2 } }, { o: { b: 2, a: 1 } })).toBe(true);
  });

  it("in judges by per-element equivalence", () => {
    expect(evaluateVisibleWhen({ ref: "$state.tab", in: ["a", "b"] }, { tab: "b" })).toBe(true);
    expect(evaluateVisibleWhen({ ref: "$state.tab", in: ["a", "b"] }, { tab: "c" })).toBe(false);
  });

  it("a missing key in state (undefined) is a non-match without colliding with null", () => {
    expect(evaluateVisibleWhen({ ref: "$state.miss", eq: null }, {})).toBe(false);
    expect(evaluateVisibleWhen({ ref: "$state.miss", ne: null }, {})).toBe(true);
  });

  it("truth table for numeric comparisons gt/lt/gte/lte (non-numeric is always false)", () => {
    expect(evaluateVisibleWhen({ ref: "$state.n", gt: 3 }, { n: 4 })).toBe(true);
    expect(evaluateVisibleWhen({ ref: "$state.n", gt: 3 }, { n: 3 })).toBe(false);
    expect(evaluateVisibleWhen({ ref: "$state.n", gte: 3 }, { n: 3 })).toBe(true);
    expect(evaluateVisibleWhen({ ref: "$state.n", lt: 3 }, { n: 2 })).toBe(true);
    expect(evaluateVisibleWhen({ ref: "$state.n", lte: 3 }, { n: 3 })).toBe(true);
    expect(evaluateVisibleWhen({ ref: "$state.n", lt: 3 }, { n: 3 })).toBe(false);
    // non-numeric (string / boolean / null / missing) is always false in numeric comparison
    expect(evaluateVisibleWhen({ ref: "$state.n", gt: 3 }, { n: "4" })).toBe(false);
    expect(evaluateVisibleWhen({ ref: "$state.n", gt: 3 }, { n: true })).toBe(false);
    expect(evaluateVisibleWhen({ ref: "$state.n", gt: 3 }, { n: null })).toBe(false);
    expect(evaluateVisibleWhen({ ref: "$state.n", gt: 3 }, {})).toBe(false);
  });

  it("exists judges by whether the value is other than null/undefined", () => {
    expect(evaluateVisibleWhen({ ref: "$state.v", exists: true }, { v: 0 })).toBe(true);
    expect(evaluateVisibleWhen({ ref: "$state.v", exists: true }, { v: "" })).toBe(true);
    expect(evaluateVisibleWhen({ ref: "$state.v", exists: true }, { v: false })).toBe(true);
    expect(evaluateVisibleWhen({ ref: "$state.v", exists: true }, { v: null })).toBe(false);
    expect(evaluateVisibleWhen({ ref: "$state.v", exists: true }, {})).toBe(false);
    // exists:false treats absence (null/undefined) as true
    expect(evaluateVisibleWhen({ ref: "$state.v", exists: false }, { v: null })).toBe(true);
    expect(evaluateVisibleWhen({ ref: "$state.v", exists: false }, {})).toBe(true);
    expect(evaluateVisibleWhen({ ref: "$state.v", exists: false }, { v: 1 })).toBe(false);
  });

  it("recursively evaluates all / any / not", () => {
    const state = { tab: "a", n: 5 };
    // all: true when all are true
    expect(
      evaluateVisibleWhen(
        {
          all: [
            { ref: "$state.tab", eq: "a" },
            { ref: "$state.n", gte: 5 },
          ],
        },
        state,
      ),
    ).toBe(true);
    // all: false if even one is false
    expect(
      evaluateVisibleWhen(
        {
          all: [
            { ref: "$state.tab", eq: "a" },
            { ref: "$state.n", gt: 5 },
          ],
        },
        state,
      ),
    ).toBe(false);
    // any: true if even one is true
    expect(
      evaluateVisibleWhen(
        {
          any: [
            { ref: "$state.tab", eq: "z" },
            { ref: "$state.n", gte: 5 },
          ],
        },
        state,
      ),
    ).toBe(true);
    // any: false if all are false
    expect(
      evaluateVisibleWhen(
        {
          any: [
            { ref: "$state.tab", eq: "z" },
            { ref: "$state.n", gt: 5 },
          ],
        },
        state,
      ),
    ).toBe(false);
    // not: inverts
    expect(evaluateVisibleWhen({ not: { ref: "$state.tab", eq: "a" } }, state)).toBe(false);
    // nested: a combination of not(any(...)) and all
    expect(
      evaluateVisibleWhen(
        {
          all: [
            { ref: "$state.tab", in: ["a", "b"] },
            {
              not: {
                any: [
                  { ref: "$state.n", lt: 0 },
                  { ref: "$state.n", gt: 100 },
                ],
              },
            },
          ],
        },
        state,
      ),
    ).toBe(true);
  });
});

describe("collectStateRefs (recursive collection of reference keys)", () => {
  it("collects reference keys from all leaves of a compound predicate in traversal order", () => {
    const pred: VisibleWhen = {
      all: [
        { ref: "$state.tab", eq: "a" },
        { not: { ref: "$state.mode", exists: true } },
        {
          any: [
            { ref: "$state.n", gt: 3 },
            { ref: "$state.tab", ne: "z" },
          ],
        },
      ],
    };
    expect(collectStateRefs(pred)).toEqual(["tab", "mode", "n", "tab"]);
  });

  it("a single leaf returns one key", () => {
    expect(collectStateRefs({ ref: "$state.tab", eq: "a" })).toEqual(["tab"]);
  });
});

describe("validateSpecStructure: state validation", () => {
  it("valid: 0.2 + state initial value + reference-consistent visibleWhen + state.set passes", () => {
    const result = safeParseSpec(
      specInput({
        state: { tab: "a" },
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["btn", "panel"] },
          { id: "btn", type: "presentMarkdown", props: {} },
          { id: "panel", type: "presentMarkdown", props: {}, visibleWhen: { ref: "$state.tab", eq: "a" } },
        ],
        events: [{ on: "btn.press", emit: "state.set", payload: { key: "tab", value: "a" } }],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("VERSION_FEATURE_MISMATCH: putting state on 0.1 is rejected", () => {
    const result = safeParseSpec(specInput({ kohaku: "0.1", state: { tab: "a" } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("VERSION_FEATURE_MISMATCH");
  });

  it("0.1 is accepted as-is when the state feature is not used (backward compatible)", () => {
    const result = safeParseSpec(specInput({ kohaku: "0.1" }));
    expect(result.ok).toBe(true);
  });

  it("STATE_REF_UNKNOWN: rejected when a visibleWhen reference key has no initial value", () => {
    const result = safeParseSpec(
      specInput({
        state: {},
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["p"] },
          { id: "p", type: "presentMarkdown", props: {}, visibleWhen: { ref: "$state.missing", eq: "a" } },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("STATE_REF_UNKNOWN");
  });

  it("valid: passes when all reference keys of a compound visibleWhen (all/any/not) have initial values", () => {
    const result = safeParseSpec(
      specInput({
        state: { tab: "a", n: 0 },
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["panel"] },
          {
            id: "panel",
            type: "presentMarkdown",
            props: {},
            visibleWhen: {
              all: [{ ref: "$state.tab", eq: "a" }, { not: { ref: "$state.n", gt: 10 } }],
            },
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("STATE_REF_UNKNOWN: rejected when a nested leaf of a compound predicate references an undeclared key", () => {
    const result = safeParseSpec(
      specInput({
        state: { tab: "a" },
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["panel"] },
          {
            id: "panel",
            type: "presentMarkdown",
            props: {},
            visibleWhen: {
              any: [{ ref: "$state.tab", eq: "a" }, { not: { ref: "$state.missing", exists: true } }],
            },
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("STATE_REF_UNKNOWN");
  });

  it("STATE_SET_INVALID: rejected when the target key is absent from state", () => {
    const result = safeParseSpec(
      specInput({
        state: { tab: "a" },
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["btn"] },
          { id: "btn", type: "presentMarkdown", props: {} },
        ],
        events: [{ on: "btn.press", emit: "state.set", payload: { key: "nope", value: "x" } }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("STATE_SET_INVALID");
  });

  it("STATE_SET_INVALID: rejected when payload.key is not a static string (template)", () => {
    const result = safeParseSpec(
      specInput({
        state: { tab: "a" },
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["btn"] },
          { id: "btn", type: "presentMarkdown", props: {} },
        ],
        events: [{ on: "btn.press", emit: "state.set", payload: { key: "$value", value: "x" } }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("STATE_SET_INVALID");
  });
});

describe("state diff / apply round-trip", () => {
  const base: UISpec = {
    kohaku: "0.2",
    intent: INTENT,
    dataVersion: "v1",
    state: { tab: "a", count: 0 },
    components: [{ id: "root", type: "layout.stack", props: {} }],
    events: [],
    provenance: PROVENANCE,
  };

  it("state changes appear in the patch and are restored by apply", () => {
    const next: UISpec = { ...base, state: { tab: "b", count: 3 } };
    const patch = diffSpec(base, next);
    expect(patch.state).toEqual({ tab: "b", count: 3 });
    expect(applyPatch(base, patch)).toEqual(next);
  });

  it("state deletion is expressed as patch.state=null and disappears via apply", () => {
    const next: UISpec = { ...base };
    delete (next as { state?: unknown }).state;
    const patch = diffSpec(base, next);
    expect(patch.state).toBeNull();
    const applied = applyPatch(base, patch);
    expect(applied.state).toBeUndefined();
  });

  it("state does not appear in the patch when unchanged", () => {
    const next: UISpec = { ...base, dataVersion: "v2" };
    const patch = diffSpec(base, next);
    expect("state" in patch).toBe(false);
  });
});

describe("computeStructureHash: conditional inclusion of state", () => {
  const noState: UISpec = {
    kohaku: "0.2",
    intent: INTENT,
    dataVersion: "v1",
    components: [{ id: "root", type: "layout.stack", props: {} }],
    events: [],
    provenance: PROVENANCE,
  };

  it("the hash of a stateless Spec is unchanged from the legacy formula ({components, events}) (regression)", async () => {
    const expectedHex = await sha256Hex(
      canonicalStringify({ components: noState.components, events: noState.events }),
    );
    expect(await computeStructureHash(noState)).toBe(`sha256:${expectedHex}`);
  });

  it("declaring state folds it into the structure hash (a different value yields a different hash)", async () => {
    const withA: UISpec = { ...noState, state: { tab: "a" } };
    const withB: UISpec = { ...noState, state: { tab: "b" } };
    const hNo = await computeStructureHash(noState);
    const hA = await computeStructureHash(withA);
    const hB = await computeStructureHash(withB);
    expect(hA).not.toBe(hNo);
    expect(hA).not.toBe(hB);
  });
});

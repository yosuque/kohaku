import { FakeLlm } from "@kohaku-ui/llm/fake";
import {
  computeStructureHash,
  type FilterDescriptor,
  type FixationRecord,
  type GuiAction,
  type SemanticPort,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type ComposeContext, compose, materializeFixation } from "../src/index.js";
import { catalog, goodRawDraft, makeSemantic, makeStorage } from "./helpers.js";

// A fixated injected L1 Spec (ComposePolicy.l1Filters) keeps its `data.bind` values -- the read scopes its
// capability is built from. Delivery must therefore check them against the CURRENT filter descriptors
// (design.md #78), by subset of values, so a removed option is stale instead of being re-signed.

const GUI_INPUT: GuiAction = {
  kind: "gui",
  action: "facet.change",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
};

const GROUP_BY: FilterDescriptor = {
  param: "groupBy",
  queryParam: "groupBy",
  paths: ["summary"],
  label: "Group by",
  options: [
    { value: "region", label: "By region" },
    { value: "product", label: "By product" },
    { value: "channel", label: "By channel" },
  ],
};

function ctxWith(describeFilters?: SemanticPort["describeFilters"]): ComposeContext {
  return {
    catalog,
    semantic: { ...makeSemantic(), ...(describeFilters != null ? { describeFilters } : {}) },
    storage: makeStorage(),
    llm: new FakeLlm({ objects: [goodRawDraft()] }),
    policy: { l1Filters: true },
  };
}

/** The fixation of a freshly composed, filter-injected L1 Spec. */
async function injectedFixation(): Promise<{ fixation: FixationRecord; spec: UISpec }> {
  const { spec } = await compose(
    GUI_INPUT,
    ctxWith(async () => [GROUP_BY]),
  );
  expect(spec.components.some((c) => c.data?.bind != null)).toBe(true);
  const fixation: FixationRecord = {
    intentHash: spec.intent.hash,
    canonical: spec.intent.canonical,
    pinnedSpec: spec,
    structureHash: await computeStructureHash(spec),
    fixatedAt: "2026-11-08T00:00:00Z",
    approver: { id: "tester" },
    catalogFingerprint: catalog.fingerprint,
  };
  return { fixation, spec };
}

describe("materializeFixation: injected filters are checked against the current descriptors", () => {
  it("is fresh when the descriptors are unchanged", async () => {
    const { fixation, spec } = await injectedFixation();
    const { result, check } = await materializeFixation(
      fixation,
      spec.intent,
      ctxWith(async () => [GROUP_BY]),
    );
    expect(check.kind).toBe("fresh");
    expect(result?.spec.provenance.cache).toBe("fixated");
  });

  it("is stale when an option the pinned bind carries was removed (the removed scope is not re-signed)", async () => {
    const { fixation, spec } = await injectedFixation();
    const narrowed: FilterDescriptor = { ...GROUP_BY, options: GROUP_BY.options.slice(0, 2) };
    const { result, check } = await materializeFixation(
      fixation,
      spec.intent,
      ctxWith(async () => [narrowed]),
    );
    expect(result).toBeNull();
    expect(check.kind).toBe("stale");
    if (check.kind === "stale") {
      expect(check.issues.join(" ")).toContain("filter options drifted");
      expect(check.issues.join(" ")).toContain("channel");
    }
  });

  it("is stale when the filter was removed altogether, or no longer governs the carrying path", async () => {
    const { fixation, spec } = await injectedFixation();
    for (const now of [[], [{ ...GROUP_BY, paths: ["trend"] }]]) {
      const { result, check } = await materializeFixation(
        fixation,
        spec.intent,
        ctxWith(async () => now),
      );
      expect(result).toBeNull();
      expect(check.kind).toBe("stale");
    }
  });

  it("compares by subset of values, not by hash: a label change or a widened vocabulary stays deliverable", async () => {
    const { fixation, spec } = await injectedFixation();
    const relabelled: FilterDescriptor = {
      ...GROUP_BY,
      label: "集計軸",
      options: GROUP_BY.options.map((o) => ({ ...o, label: `${o.label} (renamed)` })),
    };
    const widened: FilterDescriptor = {
      ...GROUP_BY,
      options: [...GROUP_BY.options, { value: "weekday", label: "By weekday" }],
    };
    for (const now of [relabelled, widened]) {
      const { result, check } = await materializeFixation(
        fixation,
        spec.intent,
        ctxWith(async () => [now]),
      );
      expect(check.kind).toBe("fresh");
      expect(result).not.toBeNull();
    }
  });

  it("keeps today's behaviour without a descriptor source, or when describeFilters throws", async () => {
    const { fixation, spec } = await injectedFixation();
    for (const describe of [
      undefined,
      async (): Promise<FilterDescriptor[]> => {
        throw new Error("boom");
      },
    ]) {
      const { result, check } = await materializeFixation(fixation, spec.intent, ctxWith(describe));
      expect(check.kind).toBe("fresh");
      expect(result).not.toBeNull();
    }
  });

  it("forwards the tenant to describeFilters, and never calls it for a Spec without data.bind", async () => {
    const { fixation, spec } = await injectedFixation();
    const seen: unknown[] = [];
    await materializeFixation(
      fixation,
      spec.intent,
      ctxWith(async (_i, c) => {
        seen.push(c);
        return [GROUP_BY];
      }),
      "acme",
    );
    expect(seen).toEqual([{ tenant: "acme" }]);

    let called = 0;
    const plain: UISpec = {
      ...spec,
      components: spec.components.map((c) => {
        if (c.data?.bind == null) return c;
        const { bind: _bind, ...data } = c.data;
        return { ...c, data };
      }),
    };
    const plainFixation: FixationRecord = {
      ...fixation,
      pinnedSpec: plain,
      structureHash: await computeStructureHash(plain),
    };
    const { check } = await materializeFixation(
      plainFixation,
      spec.intent,
      ctxWith(async () => {
        called++;
        return [];
      }),
    );
    expect(check.kind).toBe("fresh");
    expect(called).toBe(0);
  });
});

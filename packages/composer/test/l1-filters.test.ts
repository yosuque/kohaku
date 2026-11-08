import { FakeLlm } from "@kohaku-ui/llm/fake";
import {
  type FilterDescriptor,
  type GuiAction,
  type SemanticPort,
  type UISpec,
  validateSpecStructure,
} from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type ComposeContext, type ComposePolicy, compose, composeStream } from "../src/index.js";
import { catalog, goodRawDraft, makeSemantic, makeStorage } from "./helpers.js";

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

function semanticWith(describeFilters?: SemanticPort["describeFilters"]): SemanticPort {
  return { ...makeSemantic(), ...(describeFilters != null ? { describeFilters } : {}) };
}

function makeCtx(
  policy: ComposePolicy,
  semantic: SemanticPort = semanticWith(async () => [GROUP_BY]),
): ComposeContext {
  return {
    catalog,
    semantic,
    storage: makeStorage(),
    llm: new FakeLlm({ objects: [goodRawDraft()] }),
    policy,
  };
}

describe("ComposePolicy.l1Filters", () => {
  it("injects the Intent's filters into a generated L1 Spec (control, state, event, bind) and the Spec validates", async () => {
    const { spec, trace } = await compose(GUI_INPUT, makeCtx({ l1Filters: true }));
    expect(spec.provenance.tier).toBe("L1");
    expect(trace.filters).toEqual({ injected: ["groupBy"] });
    expect(spec.state).toEqual({ groupBy: "region" });

    const control = spec.components.find((c) => c.type === "control.select");
    expect(control?.id).toBe("filter-groupBy");
    // The injected control went through canonicalProps like every other node (catalog version filled).
    expect(control?.version).toBeDefined();
    expect(spec.components[0]?.children?.[0]).toBe("filter-groupBy");

    const bound = spec.components.filter((c) => c.data?.bind != null);
    expect(bound.length).toBeGreaterThanOrEqual(2);
    for (const c of bound) {
      expect(c.data?.bind).toEqual({
        groupBy: { $state: "groupBy", values: ["region", "product", "channel"] },
      });
    }
    expect(spec.events).toContainEqual({
      on: "filter-groupBy.change",
      emit: "state.set",
      payload: { key: "groupBy", value: "$value" },
    });
    expect(validateSpecStructure(spec).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("is off by default: no injection, no trace.filters, and describeFilters is never called", async () => {
    let called = 0;
    const semantic = semanticWith(async () => {
      called++;
      return [GROUP_BY];
    });
    for (const policy of [{}, { l1Filters: false }]) {
      const { spec, trace } = await compose(GUI_INPUT, makeCtx(policy, semantic));
      expect(spec.state).toBeUndefined();
      expect(spec.components.some((c) => c.type === "control.select")).toBe(false);
      expect(trace.filters).toBeUndefined();
    }
    expect(called).toBe(0);
  });

  it("separates the cache key from the same policy without it (policyFingerprint)", async () => {
    const off = await compose(GUI_INPUT, makeCtx({}));
    const on = await compose(GUI_INPUT, makeCtx({ l1Filters: true }));
    expect(on.trace.cacheKey).not.toBe(off.trace.cacheKey);
    expect(on.trace.cacheKeyParts.policyFingerprint).toBeDefined();
    expect(off.trace.cacheKeyParts.policyFingerprint).toBeUndefined();
  });

  it("serves the injected Spec from the cache on the second compose (no second generation)", async () => {
    const ctx = makeCtx({ l1Filters: true });
    const first = await compose(GUI_INPUT, ctx);
    const second = await compose(GUI_INPUT, { ...ctx, llm: new FakeLlm({ objects: [] }) });
    expect(second.trace.cache).toBe("hit");
    expect(second.spec.state).toEqual(first.spec.state);
    expect(second.spec.components).toEqual(first.spec.components);
  });

  it("delivers the Spec as generated when the SemanticPort has no describeFilters, returns [], or throws", async () => {
    const plain = goodRawDraft();
    for (const semantic of [
      semanticWith(),
      semanticWith(async () => []),
      semanticWith(async () => {
        throw new Error("boom");
      }),
    ]) {
      const ctx = { ...makeCtx({ l1Filters: true }, semantic), llm: new FakeLlm({ objects: [plain] }) };
      const { spec, trace } = await compose(GUI_INPUT, ctx);
      expect(spec.provenance.tier).toBe("L1");
      expect(spec.state).toBeUndefined();
      expect(spec.components.some((c) => c.type === "control.select")).toBe(false);
      expect(trace.filters).toBeUndefined();
    }
  });

  it("falls back to the un-injected Spec and records the reason when the variant limit is exceeded", async () => {
    const many: FilterDescriptor = {
      ...GROUP_BY,
      options: [
        { value: "region", label: "region" },
        ...Array.from({ length: 200 }, (_, i) => ({ value: `v${i}`, label: `v${i}` })),
      ],
    };
    const { spec, trace } = await compose(
      GUI_INPUT,
      makeCtx(
        { l1Filters: true },
        semanticWith(async () => [many]),
      ),
    );
    expect(trace.filters).toEqual({ injected: [], skipped: "variant-limit" });
    expect(spec.state).toBeUndefined();
    expect(spec.components.some((c) => c.type === "control.select")).toBe(false);
  });

  it("passes the resolved tenant and the session locale to describeFilters (and nothing when there is no session)", async () => {
    const seen: unknown[] = [];
    const semantic = semanticWith(async (_intent, c) => {
      seen.push(c);
      return [GROUP_BY];
    });
    await compose(GUI_INPUT, makeCtx({ l1Filters: true }, semantic), {
      session: { surface: "web", tenant: "acme", locale: "ja" },
    });
    await compose(GUI_INPUT, makeCtx({ l1Filters: true, cacheMode: "bypass" }, semantic));
    expect(seen).toEqual([{ tenant: "acme", locale: "ja" }, undefined]);
  });

  describe("the authorized range is part of the cache key", () => {
    const widened: FilterDescriptor = {
      ...GROUP_BY,
      options: [...GROUP_BY.options, { value: "weekday", label: "By weekday" }],
    };

    it("changing the options (or labels, or paths) yields a different cache key", async () => {
      const keys = new Set<string>();
      for (const d of [
        GROUP_BY,
        widened,
        { ...GROUP_BY, label: "Group by (renamed)" },
        { ...GROUP_BY, paths: ["summary", "trend"] },
      ]) {
        const { trace } = await compose(
          GUI_INPUT,
          makeCtx(
            { l1Filters: true },
            semanticWith(async () => [d]),
          ),
        );
        keys.add(trace.cacheKey);
      }
      expect(keys.size).toBe(4);
      const off = await compose(
        GUI_INPUT,
        makeCtx(
          {},
          semanticWith(async () => [GROUP_BY]),
        ),
      );
      expect(keys.has(off.trace.cacheKey)).toBe(false);
    });

    it("the same descriptors give the same key (the hash is canonical)", async () => {
      const a = await compose(
        GUI_INPUT,
        makeCtx(
          { l1Filters: true },
          semanticWith(async () => [GROUP_BY]),
        ),
      );
      const b = await compose(
        GUI_INPUT,
        makeCtx(
          { l1Filters: true },
          semanticWith(async () => [{ ...GROUP_BY }]),
        ),
      );
      expect(a.trace.cacheKey).toBe(b.trace.cacheKey);
    });

    it("tenant-specific descriptors do not share a cached Spec", async () => {
      const semantic = semanticWith(async (_intent, c) => [c?.tenant === "narrow" ? GROUP_BY : widened]);
      const storage = makeStorage();
      const ctx = (llm: FakeLlm): ComposeContext => ({
        catalog,
        semantic,
        storage,
        llm,
        policy: { l1Filters: true },
      });
      const wide = await compose(GUI_INPUT, ctx(new FakeLlm({ objects: [goodRawDraft()] })), {
        session: { surface: "web", tenant: "wide" },
      });
      const narrow = await compose(GUI_INPUT, ctx(new FakeLlm({ objects: [goodRawDraft()] })), {
        session: { surface: "web", tenant: "narrow" },
      });
      // The narrow tenant is a miss that regenerates; it never receives the wide tenant's authorized range.
      expect(narrow.trace.cache).toBe("miss");
      expect(narrow.trace.cacheKey).not.toBe(wide.trace.cacheKey);
      const values = (spec: UISpec): string[] | undefined =>
        spec.components.find((c) => c.data?.bind != null)?.data?.bind?.["groupBy"]?.values;
      expect(values(wide.spec)).toContain("weekday");
      expect(values(narrow.spec)).not.toContain("weekday");
      // Each tenant hits its own entry the second time.
      const again = await compose(GUI_INPUT, ctx(new FakeLlm({ objects: [] })), {
        session: { surface: "web", tenant: "narrow" },
      });
      expect(again.trace.cache).toBe("hit");
      expect(values(again.spec)).toEqual(values(narrow.spec));
    });

    it("session locales are cached separately and carry their own labels", async () => {
      const semantic = semanticWith(async (_intent, c) => [
        c?.locale === "ja" ? { ...GROUP_BY, label: "集計軸" } : GROUP_BY,
      ]);
      const storage = makeStorage();
      const ctx = (): ComposeContext => ({
        catalog,
        semantic,
        storage,
        llm: new FakeLlm({ objects: [goodRawDraft()] }),
        policy: { l1Filters: true },
      });
      const en = await compose(GUI_INPUT, ctx(), { session: { surface: "web", locale: "en" } });
      const ja = await compose(GUI_INPUT, ctx(), { session: { surface: "web", locale: "ja" } });
      expect(ja.trace.cache).toBe("miss");
      expect(ja.trace.cacheKey).not.toBe(en.trace.cacheKey);
      const label = (spec: UISpec): unknown =>
        spec.components.find((c) => c.type === "control.select")?.props["label"];
      expect(label(en.spec)).toBe("Group by");
      expect(label(ja.spec)).toBe("集計軸");
    });
  });

  describe("l1FiltersMaxVariants", () => {
    it("exceeding the cap delivers the Spec as generated; the cap is part of the cache key only when not 64", async () => {
      // 3 options x 2 data components = 6 variants.
      const tight = await compose(GUI_INPUT, makeCtx({ l1Filters: true, l1FiltersMaxVariants: 5 }));
      expect(tight.trace.filters).toEqual({ injected: [], skipped: "variant-limit" });
      expect(tight.spec.state).toBeUndefined();
      const roomy = await compose(GUI_INPUT, makeCtx({ l1Filters: true, l1FiltersMaxVariants: 6 }));
      expect(roomy.trace.filters).toEqual({ injected: ["groupBy"] });
      const dflt = await compose(GUI_INPUT, makeCtx({ l1Filters: true }));
      const explicit64 = await compose(GUI_INPUT, makeCtx({ l1Filters: true, l1FiltersMaxVariants: 64 }));
      expect(explicit64.trace.cacheKey).toBe(dflt.trace.cacheKey);
      expect(roomy.trace.cacheKey).not.toBe(dflt.trace.cacheKey);
      expect(tight.trace.cacheKey).not.toBe(roomy.trace.cacheKey);
    });
  });

  describe("shape guard: a filter whose options rename the result's columns is dropped", () => {
    const REGION_SHAPE = {
      columns: [
        { name: "region", type: "string" as const, role: "dimension" as const },
        { name: "revenue", type: "number" as const, role: "measure" as const },
      ],
    };
    const PRODUCT_SHAPE = {
      columns: [
        { name: "product", type: "string" as const, role: "dimension" as const },
        { name: "revenue", type: "number" as const, role: "measure" as const },
      ],
    };
    /** describeShape keyed by the ref's groupBy value: region keeps `region`, any other value renames the dimension. */
    function shapeByGroupBy(seen?: string[]): SemanticPort["describeShape"] {
      return async (handle) => {
        seen?.push(handle.uri);
        return new URL(handle.uri.replace("query://", "http://")).searchParams.get("groupBy") === "region"
          ? REGION_SHAPE
          : PRODUCT_SHAPE;
      };
    }
    const ctxWith = (describeShape: SemanticPort["describeShape"] | undefined): ComposeContext => {
      const semantic = { ...semanticWith(async () => [GROUP_BY]) };
      if (describeShape != null) semantic.describeShape = describeShape;
      else delete semantic.describeShape;
      return makeCtx({ l1Filters: true }, semantic);
    };

    it("drops a descriptor whose variants change the column set (the Spec is delivered as generated)", async () => {
      const seen: string[] = [];
      const { spec, trace } = await compose(GUI_INPUT, ctxWith(shapeByGroupBy(seen)));
      expect(spec.provenance.tier).toBe("L1");
      expect(trace.filters).toBeUndefined();
      expect(spec.state).toBeUndefined();
      expect(spec.components.some((c) => c.type === "control.select")).toBe(false);
      expect(spec.components.some((c) => c.data?.bind != null)).toBe(false);
      // The first renaming variant (product) settled it; the current one (region) was not asked a second time.
      expect(seen.filter((u) => u.includes("groupBy=product"))).toHaveLength(1);
    });

    it("keeps a descriptor whose variants keep the column set", async () => {
      const { spec, trace } = await compose(
        GUI_INPUT,
        ctxWith(async () => REGION_SHAPE),
      );
      expect(trace.filters).toEqual({ injected: ["groupBy"] });
      expect(spec.components.some((c) => c.type === "control.select")).toBe(true);
    });

    it("column order is not a shape change", async () => {
      const reordered = { columns: [...REGION_SHAPE.columns].reverse() };
      const { trace } = await compose(
        GUI_INPUT,
        ctxWith(async (h) => (h.uri.includes("groupBy=region") ? REGION_SHAPE : reordered)),
      );
      expect(trace.filters).toEqual({ injected: ["groupBy"] });
    });

    it("drops a descriptor when a variant's shape cannot be described", async () => {
      const { trace } = await compose(
        GUI_INPUT,
        ctxWith(async (h) => {
          if (h.uri.includes("groupBy=channel")) throw new Error("unknown query path");
          return REGION_SHAPE;
        }),
      );
      expect(trace.filters).toBeUndefined();
    });

    it("leaves the descriptor alone when there is nothing to compare against (no describeShape, or the base shape is unknown)", async () => {
      const without = await compose(GUI_INPUT, ctxWith(undefined));
      expect(without.trace.filters).toEqual({ injected: ["groupBy"] });
      // The initial handle's own shape fails: the guard has no baseline, so it keeps today's behaviour.
      const noBase = await compose(
        GUI_INPUT,
        ctxWith(async (h) => {
          if (h.uri.includes("groupBy=region")) throw new Error("no shape");
          return PRODUCT_SHAPE;
        }),
      );
      expect(noBase.trace.filters).toEqual({ injected: ["groupBy"] });
    });

    it("a dropped descriptor changes the cache key (the hash covers the descriptors actually used)", async () => {
      const kept = await compose(
        GUI_INPUT,
        ctxWith(async () => REGION_SHAPE),
      );
      const dropped = await compose(GUI_INPUT, ctxWith(shapeByGroupBy()));
      expect(dropped.trace.cacheKey).not.toBe(kept.trace.cacheKey);
    });
  });

  it("records skipped: invalid at compose level when the generated root cannot host controls", async () => {
    // A single-component screen: the root is the chart itself (no children), so there is nowhere to put a control.
    const leafRootDraft = {
      components: [
        {
          id: "root",
          type: "presentChart",
          props: { kind: "bar", x: "region", y: "revenue", series: null, stacked: null, title: null },
          children: null,
          data: { $ref: "query://sales/summary?fy=2026&groupBy=region&q=3" },
        },
      ],
      events: [],
    };
    const ctx = { ...makeCtx({ l1Filters: true }), llm: new FakeLlm({ objects: [leafRootDraft] }) };
    const { spec, trace } = await compose(GUI_INPUT, ctx);
    expect(spec.provenance.fallback).toBeUndefined();
    expect(spec.provenance.tier).toBe("L1");
    expect(spec.state).toBeUndefined();
    expect(trace.filters).toEqual({ injected: [], skipped: "invalid" });
  });

  it("does not inject into an L0 fixed Spec", async () => {
    const ctx = makeCtx({
      l1Filters: true,
      fixedSpecs: {
        async lookup() {
          return (intent, handles): UISpec => ({
            kohaku: "0.2",
            intent,
            dataVersion: "template",
            components: [
              { id: "root", type: "layout.stack", props: {}, children: ["c"] },
              {
                id: "c",
                type: "presentChart",
                props: { kind: "bar", x: "region", y: "revenue" },
                data: { $ref: handles[0]!.uri },
              },
            ],
            events: [],
            provenance: { tier: "L0", composedBy: "fixed-spec-template", cache: "miss" },
          });
        },
      },
    });
    const { spec, trace } = await compose(GUI_INPUT, ctx);
    expect(spec.provenance.tier).toBe("L0");
    expect(spec.components.some((c) => c.type === "control.select")).toBe(false);
    expect(trace.filters).toBeUndefined();
  });

  it("composeStream converges on the injected Spec in its final patch", async () => {
    const ctx = makeCtx({ l1Filters: true });
    const events = [];
    for await (const ev of composeStream(
      {
        kind: "intent",
        intent: {
          canonical: "sales.quarterly_summary",
          params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
        },
      },
      ctx,
    )) {
      events.push(ev);
    }
    const patches = events.filter((e) => e.kind === "patch");
    const last = patches.at(-1);
    expect(last?.kind === "patch" && last.spec.state).toEqual({ groupBy: "region" });
    // Exactly the last patch is marked converged (the host attaches the bind-variant capability to it).
    expect(patches.filter((p) => p.kind === "patch" && p.converged === true)).toHaveLength(1);
    expect(last?.kind === "patch" && last.converged).toBe(true);
    const done = events.at(-1);
    expect(done?.kind).toBe("done");
  });
});

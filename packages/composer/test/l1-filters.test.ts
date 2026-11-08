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
import { catalog, goodRawDraft, makeSemantic, makeStorage, REF } from "./helpers.js";

const GUI_INPUT: GuiAction = {
  kind: "gui",
  action: "facet.change",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
};

const GROUP_BY: FilterDescriptor = {
  param: "groupBy",
  queryParam: "groupBy",
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

  it("passes the resolved tenant to describeFilters, and no locale", async () => {
    let seen: unknown;
    const semantic = semanticWith(async (_intent, c) => {
      seen = c;
      return [GROUP_BY];
    });
    await compose(GUI_INPUT, makeCtx({ l1Filters: true }, semantic), {
      session: { surface: "web", tenant: "acme", locale: "ja" },
    });
    expect(seen).toEqual({ tenant: "acme" });
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
    // Exactly the last patch is marked final (the host attaches the bind-variant capability to it).
    expect(patches.filter((p) => p.kind === "patch" && p.final === true)).toHaveLength(1);
    expect(last?.kind === "patch" && last.final).toBe(true);
    const done = events.at(-1);
    expect(done?.kind).toBe("done");
    expect(REF).toContain("groupBy=region");
  });
});

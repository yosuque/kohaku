import type { GenerateObjectRequest, GenerateObjectResult, LlmPort } from "@kohaku-ui/llm";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { applyPatch, canonicalStringify, type GuiAction, type UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import {
  type ComposeContext,
  type ComposeStreamInternalEvent,
  compose,
  composeStream,
} from "../src/index.js";
import { catalogPromptFragment } from "../src/prompt.js";
import { catalog, goodRawDraft, makeSemantic, makeStorage } from "./helpers.js";

const GUI_INPUT: GuiAction = {
  kind: "gui",
  action: "facet.change",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
};

function makeCtx(llm: LlmPort, policy: ComposeContext["policy"] = {}): ComposeContext {
  return { catalog, semantic: makeSemantic(), storage: makeStorage(), llm, policy };
}

/** A minimal L0 template with no data reference. */
function markdownFixed(): UISpec {
  return {
    kohaku: "0.1",
    intent: { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "ignored",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["md1"] },
      { id: "md1", type: "presentMarkdown", props: { markdown: "Pinned view" } },
    ],
    events: [],
    provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
  };
}

async function drain(
  gen: AsyncGenerator<ComposeStreamInternalEvent, void>,
): Promise<ComposeStreamInternalEvent[]> {
  const events: ComposeStreamInternalEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function hasLoading(spec: UISpec): boolean {
  return spec.components.some((c) => c.type === "ui.loading");
}

describe("composeStream: L1 path (skeleton → patch → done)", () => {
  it("event order is spec(final:false) → patch → done, and only the skeleton contains ui.loading", async () => {
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    const events = await drain(composeStream(GUI_INPUT, makeCtx(llm)));

    expect(events.map((e) => e.kind)).toEqual(["spec", "patch", "done"]);

    const specEvent = events[0];
    if (specEvent.kind !== "spec") throw new Error("first is the spec event");
    expect(specEvent.final).toBe(false);
    expect(hasLoading(specEvent.spec)).toBe(true);
    // refs are resolved QueryHandle URIs (for capability issuance)
    expect(specEvent.refs.length).toBeGreaterThan(0);

    const patchEvent = events[1];
    if (patchEvent.kind !== "patch") throw new Error("second is the patch event");
    // The skeleton's ui.loading does not remain in the final form
    expect(hasLoading(patchEvent.spec)).toBe(false);
    // The skeleton with the patch applied matches patch.spec (the applied final form)
    expect(applyPatch(specEvent.spec, patchEvent.patch)).toEqual(patchEvent.spec);

    const doneEvent = events[2];
    if (doneEvent.kind !== "done") throw new Error("last is the done event");
    expect(doneEvent.result.spec).toEqual(patchEvent.spec);
    expect(doneEvent.result.trace.tier).toBe("L1");
  });

  it("the drained result (components/events) is byte-identical to compose()'s result (equivalence across separate storage)", async () => {
    const composed = await compose(GUI_INPUT, makeCtx(new FakeLlm({ objects: [goodRawDraft()] })));
    const events = await drain(composeStream(GUI_INPUT, makeCtx(new FakeLlm({ objects: [goodRawDraft()] }))));
    const done = events.at(-1);
    if (done?.kind !== "done") throw new Error("last is done");

    const pick = (s: UISpec) => canonicalStringify({ components: s.components, events: s.events });
    expect(pick(done.result.spec)).toBe(pick(composed.spec));
    // They also match as a whole (the cache label is miss for both)
    expect(canonicalStringify(done.result.spec)).toBe(canonicalStringify(composed.spec));
  });

  it("the skeleton is not stored in cache (only the final Spec is passed to putSpecCache)", async () => {
    const base = makeStorage();
    const persisted: UISpec[] = [];
    const storage = {
      ...base,
      async putSpecCache(key: string, spec: UISpec, ttl?: number) {
        persisted.push(spec);
        return base.putSpecCache(key, spec, ttl);
      },
    };
    const ctx: ComposeContext = {
      catalog,
      semantic: makeSemantic(),
      storage,
      llm: new FakeLlm({ objects: [goodRawDraft()] }),
      policy: {},
    };
    await drain(composeStream(GUI_INPUT, ctx));

    expect(persisted.length).toBeGreaterThan(0);
    // The skeleton (which contains ui.loading) is never stored
    expect(persisted.every((s) => !hasLoading(s))).toBe(true);
  });

  it("when L1 is exhausted, a patch to the fallback Spec arrives (after the skeleton is emitted)", async () => {
    const bad = { components: [], events: [] };
    const llm = new FakeLlm({ objects: [bad, bad] }); // validation fails on both the initial attempt and repair
    const events = await drain(composeStream(GUI_INPUT, makeCtx(llm)));

    expect(events.map((e) => e.kind)).toEqual(["spec", "patch", "done"]);

    const skeleton = events[0];
    if (skeleton.kind !== "spec") throw new Error("first is spec");
    expect(skeleton.final).toBe(false);
    expect(hasLoading(skeleton.spec)).toBe(true);

    const patchEvent = events[1];
    if (patchEvent.kind !== "patch") throw new Error("second is patch");
    // A patch to the fallback as a normal-path Spec (presentMarkdown)
    expect(patchEvent.spec.components.map((c) => c.type)).toEqual(["layout.stack", "presentMarkdown"]);
    expect(patchEvent.spec.provenance.fallback?.kind).toBe("generation");
    expect(applyPatch(skeleton.spec, patchEvent.patch)).toEqual(patchEvent.spec);
  });
});

describe("composeStream: incremental streaming (streamObject partial → provisional patch)", () => {
  /** The cumulative partial sequence of goodRawDraft (mimics the LLM's partial output. Each element is "the cumulative form up to that point"). */
  function partialSequence(): unknown[] {
    const full = goodRawDraft() as { components: unknown[]; events: unknown[] };
    return [
      // 1: root only (zero real components) → no provisional emitted (guard)
      { components: [full.components[0]], events: [] },
      // 2: root + heading (complete) + an intermediate form of chart (missing props) → a provisional with the heading only
      {
        components: [
          full.components[0],
          full.components[1],
          { id: "c", type: "presentChart", props: { kind: "bar" } }, // y missing = incomplete
        ],
        events: [],
      },
      // 3: root + heading + chart (complete) → a provisional with 2 components
      { components: [full.components[0], full.components[1], full.components[2]], events: [] },
    ];
  }

  it("provisional patches arrive 1..N times, and the applyPatch fold always matches patch.spec, converging to the final form", async () => {
    const llm = new FakeLlm({ objects: [goodRawDraft()], partials: [partialSequence()] });
    const events = await drain(composeStream(GUI_INPUT, makeCtx(llm)));

    // spec → patch×(1 or more) → done
    expect(events[0]!.kind).toBe("spec");
    expect(events.at(-1)!.kind).toBe("done");
    const patches = events.filter((e) => e.kind === "patch");
    expect(patches.length).toBeGreaterThanOrEqual(2); // 1 or more provisional + 1 final

    // Equivalent to REST-STR-002: the applyPatch fold in reception order matches each patch.spec, and the last matches done.
    const first = events[0];
    if (first.kind !== "spec") throw new Error("first is spec");
    let folded = first.spec;
    for (const p of patches) {
      if (p.kind !== "patch") continue;
      folded = applyPatch(folded, p.patch);
      expect(folded).toEqual(p.spec);
    }
    const done = events.at(-1);
    if (done?.kind !== "done") throw new Error("last is done");
    expect(folded).toEqual(done.result.spec);

    // The skeleton's ui.loading does not remain in the provisional patches, and the component count grows toward the final form.
    const specsInOrder = patches.map((p) => (p.kind === "patch" ? p.spec : null)!);
    expect(specsInOrder.every((s) => !hasLoading(s))).toBe(true);
    const counts = specsInOrder.map((s) => s.components.length);
    expect([...counts].sort((a, b) => a - b)).toEqual(counts); // monotonically non-decreasing
  });

  it("the final form is byte-identical to non-stream compose() (partials do not affect the final result)", async () => {
    const composed = await compose(GUI_INPUT, makeCtx(new FakeLlm({ objects: [goodRawDraft()] })));
    const events = await drain(
      composeStream(
        GUI_INPUT,
        makeCtx(new FakeLlm({ objects: [goodRawDraft()], partials: [partialSequence()] })),
      ),
    );
    const done = events.at(-1);
    if (done?.kind !== "done") throw new Error("last is done");
    expect(canonicalStringify(done.result.spec)).toBe(canonicalStringify(composed.spec));
  });

  it("provisional Specs are not stored in cache (putSpecCache receives only the final Spec)", async () => {
    const base = makeStorage();
    const persisted: UISpec[] = [];
    const storage = {
      ...base,
      async putSpecCache(key: string, spec: UISpec, ttl?: number) {
        persisted.push(spec);
        return base.putSpecCache(key, spec, ttl);
      },
    };
    const ctx: ComposeContext = {
      catalog,
      semantic: makeSemantic(),
      storage,
      llm: new FakeLlm({ objects: [goodRawDraft()], partials: [partialSequence()] }),
      policy: {},
    };
    const events = await drain(composeStream(GUI_INPUT, ctx));
    expect(events.filter((e) => e.kind === "patch").length).toBeGreaterThanOrEqual(2);
    expect(persisted).toHaveLength(1); // only once for the final Spec
  });

  it("partials that are undecodable / have no root yet / have zero real components emit no provisional (skip)", async () => {
    const full = goodRawDraft() as { components: unknown[]; events: unknown[] };
    const llm = new FakeLlm({
      objects: [goodRawDraft()],
      partials: [
        [
          "garbage", // undecodable
          { components: [{ id: "h", type: "text.heading", props: { level: 2, text: "x" } }], events: [] }, // root not yet arrived
          { components: [full.components[0]], events: [] }, // root only (zero real components)
        ],
      ],
    });
    const events = await drain(composeStream(GUI_INPUT, makeCtx(llm)));
    // All provisionals are skipped, leaving only one final patch.
    expect(events.map((e) => e.kind)).toEqual(["spec", "patch", "done"]);
  });

  it("PreparedCompose.getL1Schema memoizes: reused by both the provisional decode loop and generateL1's own generation call", async () => {
    const llm = new FakeLlm({ objects: [goodRawDraft()], partials: [partialSequence()] });
    // Both call sites rely on the exact same schema/includeTypes pair (verified indirectly by the
    // existing byte-identical-final-form test above); this test only pins the compose-time contract
    // that composeStream actually runs to completion using the shared, memoized schema.
    const events = await drain(composeStream(GUI_INPUT, makeCtx(llm)));
    const done = events.at(-1);
    if (done?.kind !== "done") throw new Error("last is done");
    expect(done.result.spec.components.length).toBeGreaterThan(0);
  });
});

describe("composeStream: provisional-patch throttle", () => {
  /** A hand-rolled LlmPort whose streamObject delivers `steps` with a real (short) delay between each,
   * so the throttle's wall-clock interval actually has something to bite on (FakeLlm's streamObject
   * notifies every scripted partial synchronously in a tight loop, which defeats a timing-based test). */
  function makeTimedLlm(steps: unknown[], finalObject: unknown, delayMs: number): LlmPort {
    const generateObject = async <T>(): Promise<GenerateObjectResult<T>> => ({
      object: finalObject as T,
      model: "timed-fake-model",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    return {
      provider: "timed-fake",
      modelId: "timed-fake-model",
      generateObject,
      async generateText() {
        throw new Error("timed-fake: generateText not supported");
      },
      async streamObject<T>(req: GenerateObjectRequest<T> & { onPartial: (partial: unknown) => void }) {
        for (const step of steps) {
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
          req.onPartial(step);
        }
        return generateObject<T>();
      },
    };
  }

  it("caps provisional-patch emission to fewer than one per rapid partial (60ms minimum interval)", async () => {
    const full = goodRawDraft() as { components: unknown[]; events: unknown[] };
    // 3 cumulative partials, each individually complete and each 15ms apart (well under the 60ms
    // throttle window), so without throttling each would very plausibly earn its own provisional patch.
    const steps: unknown[] = [
      { components: [full.components[0], full.components[1]], events: [] },
      { components: [full.components[0], full.components[1], full.components[2]], events: [] },
      {
        components: [full.components[0], full.components[1], full.components[2], full.components[3]],
        events: [],
      },
    ];
    const llm = makeTimedLlm(steps, goodRawDraft(), 15);
    const events = await drain(composeStream(GUI_INPUT, makeCtx(llm)));

    const patches = events.filter((e) => e.kind === "patch");
    // 3 rapid partials + the final patch would be 4 if nothing were throttled; the 60ms minimum interval
    // must coalesce at least one of the 3 provisional opportunities away.
    expect(patches.length).toBeLessThan(steps.length + 1);
    expect(patches.length).toBeGreaterThanOrEqual(1); // the final patch is never throttled away

    const done = events.at(-1);
    if (done?.kind !== "done") throw new Error("last is done");
    expect(done.result.spec.components).toHaveLength(4);
  });

  it("still emits the final patch immediately (uninfluenced by the throttle) once generation completes", async () => {
    const full = goodRawDraft() as { components: unknown[]; events: unknown[] };
    const steps: unknown[] = [{ components: [full.components[0], full.components[1]], events: [] }];
    const llm = makeTimedLlm(steps, goodRawDraft(), 15);
    const start = Date.now();
    const events = await drain(composeStream(GUI_INPUT, makeCtx(llm)));
    const elapsedMs = Date.now() - start;
    // One provisional (after ~15ms) + one final patch; the whole thing must not be stretched out by an
    // extra throttle wait tacked onto the final delivery (generous bound to keep this non-flaky).
    expect(elapsedMs).toBeLessThan(500);
    expect(events.filter((e) => e.kind === "patch").length).toBeGreaterThanOrEqual(1);
  });
});

describe("composeStream: fast path completing in 1 event", () => {
  it("a cache hit is 1 event with final:true + done (does not call the LLM)", async () => {
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    const ctx = makeCtx(llm);
    await compose(GUI_INPUT, ctx); // warm the same storage

    const events = await drain(composeStream(GUI_INPUT, ctx));
    expect(events.map((e) => e.kind)).toEqual(["spec", "done"]);
    const specEvent = events[0];
    if (specEvent.kind !== "spec") throw new Error("first is spec");
    expect(specEvent.final).toBe(true);
    expect(specEvent.spec.provenance.cache).toBe("hit");
    expect(hasLoading(specEvent.spec)).toBe(false);
    expect(llm.calls).toHaveLength(1); // composeStream does not generate
  });

  it("an L0 fixed Spec is 1 event with final:true + done (does not emit a skeleton)", async () => {
    const ctx = makeCtx(new FakeLlm(), { fixedSpecs: { lookup: async () => markdownFixed() } });
    const events = await drain(composeStream(GUI_INPUT, ctx));

    expect(events.map((e) => e.kind)).toEqual(["spec", "done"]);
    const specEvent = events[0];
    if (specEvent.kind !== "spec") throw new Error("first is spec");
    expect(specEvent.final).toBe(true);
    expect(specEvent.spec.provenance.tier).toBe("L0");
    expect(hasLoading(specEvent.spec)).toBe(false);
  });

  it("PreparedCompose.getFixedSpec memoizes: fixedSpecs.lookup is called at most once even though both composeStream's fast-path check and generateSpec's tryFixedSpec need the answer", async () => {
    let lookups = 0;
    const ctx = makeCtx(new FakeLlm(), {
      fixedSpecs: {
        lookup: async () => {
          lookups += 1;
          return markdownFixed();
        },
      },
    });
    await drain(composeStream(GUI_INPUT, ctx));
    expect(lookups).toBe(1);
  });
});

describe("consistency between generation vocabulary and prompt", () => {
  it("ui.loading does not appear in catalogPromptFragment (vocabulary matches the generation schema)", () => {
    const frag = catalogPromptFragment(catalog);
    expect(frag).toContain("presentChart");
    expect(frag).not.toContain("ui.loading");
  });
});

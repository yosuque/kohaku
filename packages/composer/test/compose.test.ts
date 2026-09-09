import type { GenerateObjectRequest, GenerateObjectResult, LlmPort, LlmUsage } from "@kohaku-ui/llm";
import { LlmError } from "@kohaku-ui/llm";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { FixationRecord } from "@kohaku-ui/spec-core";
import {
  applyPatch,
  canonicalStringify,
  type GuiAction,
  SANDBOX_HTML_TYPE,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import {
  type ComposeContext,
  type ComposeErrorContext,
  compose,
  materializeFixation,
  recompose,
} from "../src/index.js";
import { catalog, goodRawDraft, makeMultiSemantic, makeSemantic, makeStorage, REF } from "./helpers.js";

const GUI_INPUT: GuiAction = {
  kind: "gui",
  action: "facet.change",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
};

function makeCtx(llm: LlmPort, policy: ComposeContext["policy"] = {}): ComposeContext {
  return { catalog, semantic: makeSemantic(), storage: makeStorage(), llm, policy };
}

/** One macrotask boundary (flushes all microtasks). Uses setTimeout because sha256 interposes a threadpool completion. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Advances macrotasks until the condition holds (synchronizes reliably across compose's non-deterministic sha256 wait). */
async function waitUntil(cond: () => boolean, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks && !cond(); i += 1) await tick();
}

/**
 * A ComposeContext with storage that exposes the call count of getSpecCache.
 * Used to deterministically detect, in single-flight tests, that "both calls reached the cache lookup
 * (= they are synchronously registered as in-flight immediately after)". The threadpool non-determinism of sha256 (finalizeIntent) is absorbed before this lookup.
 */
function makeCountingCtx(
  llm: LlmPort,
  policy: ComposeContext["policy"] = {},
): { ctx: ComposeContext; getCacheReads: () => number } {
  const base = makeStorage();
  let reads = 0;
  const storage = {
    ...base,
    async getSpecCache(key: string) {
      reads += 1;
      return base.getSpecCache(key);
    },
  };
  const ctx: ComposeContext = { catalog, semantic: makeSemantic(), storage, llm, policy };
  return { ctx, getCacheReads: () => reads };
}

/** Extracts one resolved reference URI from the L1 prompt (to match the generation draft's $ref). */
function refFromPrompt(prompt: string): string {
  const m = prompt.match(/query:\/\/\S+/);
  return m ? m[0] : REF;
}

/**
 * An LlmPort stub whose generateObject can be manually controlled with a gate.
 * Holds the response until released, reproducing single-flight's "a follower rides along while the leader is generating".
 */
function makeGatedLlm(
  respond: (req: GenerateObjectRequest<unknown>) => unknown = (req) =>
    goodRawDraft(refFromPrompt(req.prompt)),
  usage: LlmUsage = { inputTokens: 0, outputTokens: 0 },
) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  const llm: LlmPort = {
    provider: "gated",
    modelId: "gated-model",
    async generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
      calls += 1;
      await gate;
      return {
        object: respond(req as GenerateObjectRequest<unknown>) as T,
        usage,
        model: "gated-model",
      };
    },
    async generateText() {
      throw new Error("gated stub: generateText not supported");
    },
  };
  return { llm, release: () => release(), callCount: () => calls };
}

/** An LlmPort stub that lets usage be swapped per response, for verifying the attempts' usage. */
function makeUsageLlm(objects: unknown[], usages: LlmUsage[]): LlmPort {
  let i = 0;
  return {
    provider: "usage",
    modelId: "usage-model",
    async generateObject<T>(): Promise<GenerateObjectResult<T>> {
      const object = objects[i] as T;
      const usage = usages[i] ?? { inputTokens: 0, outputTokens: 0 };
      i += 1;
      return { object, usage, model: "usage-model" };
    },
    async generateText() {
      throw new Error("usage stub: generateText not supported");
    },
  };
}

function maskCache(spec: UISpec): string {
  return canonicalStringify({ ...spec, provenance: { ...spec.provenance, cache: "MASKED" } });
}

describe("compose: L1 constrained generation", () => {
  it("GUI action → normalization → L1 generation → deterministic post-processing yields the canonical Spec", async () => {
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    const { spec, trace } = await compose(GUI_INPUT, makeCtx(llm));

    // ID determinization (root + type-derived sequence numbers) and DFS order
    expect(spec.components.map((c) => c.id)).toEqual(["root", "title1", "chart1", "table1"]);
    // default filling (layout.stack's gap)
    expect(spec.components[0]!.props).toEqual({ direction: "vertical", gap: "md" });
    // Deterministic post-processing: a default sort descending on the measure for the spreadsheet
    expect(spec.components[3]!.props["sortBy"]).toEqual({ field: "revenue", dir: "desc" });
    // Event references are also renamed
    expect(spec.events[0]!.on).toBe("table1.rowClick");
    // Data is by reference-passing only
    expect(spec.components[2]!.data?.$ref).toBe(REF);
    expect(spec.provenance).toMatchObject({ tier: "L1", cache: "miss", model: "fake-model" });
    expect(trace.cacheKey).toContain("sha256:");
    expect(llm.calls).toHaveLength(1);
  });

  it("the 2nd time for an identical request hits the cache and does not call the LLM (R5's structural guarantee)", async () => {
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    const ctx = makeCtx(llm);
    const first = await compose(GUI_INPUT, ctx);
    const second = await compose(GUI_INPUT, ctx);

    expect(first.trace.cache).toBe("miss");
    expect(second.trace.cache).toBe("hit");
    expect(second.spec.provenance.cache).toBe("hit");
    expect(llm.calls).toHaveLength(1);
    // Everything except provenance.cache is byte-identical
    expect(maskCache(second.spec)).toBe(maskCache(first.spec));
  });

  it("when chat (NL) and GUI normalize to the same Intent, returns the same Spec", async () => {
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    const ctx = makeCtx(llm);
    const fromGui = await compose(GUI_INPUT, ctx);
    const fromNl = await compose({ kind: "nl", text: "2026 Q3 sales by region as a chart" }, ctx, {
      session: { surface: "chat" },
    });
    expect(fromNl.trace.cache).toBe("hit");
    expect(fromNl.spec.intent.hash).toBe(fromGui.spec.intent.hash);
    expect(maskCache(fromNl.spec)).toBe(maskCache(fromGui.spec));
  });

  it("repair loop: when the 1st fails validation, feeds back the error and regenerates", async () => {
    const bad = {
      components: [
        { id: "root", type: "layout.stack", props: { direction: "vertical", gap: null }, children: ["x"] },
        { id: "x", type: "no.such_type", props: {} },
      ],
      events: [],
    };
    const llm = new FakeLlm({ objects: [bad, goodRawDraft()] });
    const { spec, trace } = await compose(GUI_INPUT, makeCtx(llm));

    expect(trace.attempts).toHaveLength(2);
    expect(trace.attempts[0]!.ok).toBe(false);
    expect(trace.attempts[0]!.issues!.join()).toContain("UNKNOWN_TYPE");
    expect(trace.attempts[1]!.ok).toBe(true);
    expect(spec.provenance.tier).toBe("L1");
    // The 2nd prompt contains the repair feedback
    expect(llm.calls[1]!.prompt).toContain("Problems in the previous generation");
  });

  it("when L1 is exhausted and allowL2=false, the deterministic fallback of presentMarkdown", async () => {
    const bad = { components: [], events: [] };
    const llm = new FakeLlm({ objects: [bad, bad] });
    const { spec, trace } = await compose(GUI_INPUT, makeCtx(llm));

    expect(spec.components.map((c) => c.type)).toEqual(["layout.stack", "presentMarkdown"]);
    expect(spec.provenance.fallback?.from).toBe("L1");
    expect(spec.provenance.fallback?.kind).toBe("generation");
    expect(trace.fallback?.reason).toContain("L1");
    expect(llm.calls).toHaveLength(2); // initial + 1 repair
  });

  it("the cache label of a normal-case fallback Spec is miss", async () => {
    const bad = { components: [], events: [] };
    const llm = new FakeLlm({ objects: [bad, bad] });
    const { spec } = await compose(GUI_INPUT, makeCtx(llm));

    // Even for a fallback, when cacheMode is default, record miss
    expect(spec.provenance.fallback).toBeDefined();
    expect(spec.provenance.cache).toBe("miss");
  });

  it("the cache label of a cacheMode=bypass fallback Spec is bypass (not mis-recorded as miss)", async () => {
    const bad = { components: [], events: [] };
    const llm = new FakeLlm({ objects: [bad, bad] });
    const { spec, trace } = await compose(GUI_INPUT, makeCtx(llm, { cacheMode: "bypass" }));

    // A fallback under bypass keeps the bypass label (buildFallbackSpec's cache pass-through)
    expect(spec.provenance.fallback).toBeDefined();
    expect(spec.provenance.cache).toBe("bypass");
    expect(trace.cache).toBe("bypass");
  });

  it("an output with an out-of-set $ref is sent back as a repair issue, and succeeds when a corrected version arrives", async () => {
    // A forged reference not contained in the resolved set (REF). Mimics the prompt-JSON path that bypassed the generation-schema enum.
    const evil = "query://sales/evil?fy=2026&groupBy=region";
    const llm = new FakeLlm({ objects: [goodRawDraft(evil), goodRawDraft()] });
    const { spec, trace } = await compose(GUI_INPUT, makeCtx(llm));

    // Because catalog validation and structural validation pass, only the set-membership re-check sends back the 1st attempt
    expect(trace.attempts).toHaveLength(2);
    expect(trace.attempts[0]!.ok).toBe(false);
    expect(trace.attempts[0]!.issues!.join(" ")).toContain("INVALID_REF");
    expect(trace.attempts[0]!.issues!.join(" ")).toContain(evil);
    expect(trace.attempts[1]!.ok).toBe(true);
    expect(spec.provenance.tier).toBe("L1");
    // The repair feedback appears in the 2nd prompt
    expect(llm.calls[1]!.prompt).toContain("Problems in the previous generation");
    // The delivered Spec's $ref is the resolved set (REF) only (the forged reference does not remain)
    for (const c of spec.components) {
      if (c.data != null) expect(c.data.$ref).toBe(REF);
    }
  });

  it("if an out-of-set $ref is not fixed even by a repair retry, falls to the deterministic fallback", async () => {
    const evil = "query://sales/evil?fy=2026&groupBy=region";
    const llm = new FakeLlm({ objects: [goodRawDraft(evil), goodRawDraft(evil)] });
    const { spec, trace } = await compose(GUI_INPUT, makeCtx(llm));

    // Out-of-set references both times → L1 is exhausted and falls to the presentMarkdown fallback (prevents mis-issuing a read capability)
    expect(spec.components.map((c) => c.type)).toEqual(["layout.stack", "presentMarkdown"]);
    expect(spec.provenance.fallback?.from).toBe("L1");
    expect(trace.attempts).toHaveLength(2);
    expect(trace.attempts.every((a) => a.ok === false)).toBe(true);
    expect(llm.calls).toHaveLength(2);
  });

  it("a transient LLM failure (ABORTED) falls to the fallback immediately without a repair retry", async () => {
    // An abort such as a timeout consumes the full timeoutMs each time, so exit immediately without retrying.
    const llm = new FakeLlm({
      objects: () => {
        throw new LlmError("ABORTED", "timeout(test)");
      },
    });
    const { spec, trace } = await compose(GUI_INPUT, makeCtx(llm));

    // Try only once and fall back immediately (does not consume 2×timeout)
    expect(llm.calls).toHaveLength(1);
    expect(trace.attempts).toHaveLength(1);
    expect(trace.attempts[0]!.ok).toBe(false);
    expect(spec.provenance.fallback?.from).toBe("L1");
  });

  it("a schema-derived failure (INVALID_OUTPUT) is retried for repair", async () => {
    let call = 0;
    const llm = new FakeLlm({
      objects: () => {
        call += 1;
        if (call === 1) throw new LlmError("INVALID_OUTPUT", "schema mismatch(test)");
        return goodRawDraft();
      },
    });
    const { spec, trace } = await compose(GUI_INPUT, makeCtx(llm));

    // INVALID_OUTPUT is a repair target → succeeds on the 2nd (shows it is asymmetric with transient)
    expect(llm.calls).toHaveLength(2);
    expect(trace.attempts).toHaveLength(2);
    expect(trace.attempts[0]!.ok).toBe(false);
    expect(trace.attempts[1]!.ok).toBe(true);
    expect(spec.provenance.tier).toBe("L1");
  });
});

describe("compose: L0 / L2", () => {
  it("when an L0 fixed Spec exists, does not call the LLM and tier=L0", async () => {
    const llm = new FakeLlm();
    const fixed: UISpec = {
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
    const ctx = makeCtx(llm, { fixedSpecs: { lookup: async () => fixed } });
    const { spec, trace } = await compose(GUI_INPUT, ctx);

    expect(trace.tier).toBe("L0");
    expect(spec.provenance.tier).toBe("L0");
    expect(spec.dataVersion).toBe("sales@seed-1"); // the envelope is updated to the latest dataVersion
    expect(spec.intent.canonical).toBe("sales.quarterly_summary");
    expect(llm.calls).toHaveLength(0);
  });

  it("routeTier=L2 generates a sandbox.html node (artifact + sha256 + data reference)", async () => {
    // L2 generates a raw HTML document with generateText (no JSON wrap). title is derived from <title>.
    const llm = new FakeLlm({
      texts: [
        "<!DOCTYPE html><html><head><title>Sales calendar heatmap</title></head><body><script>window.kohaku.ready()</script></body></html>",
      ],
    });
    const ctx = makeCtx(llm, { allowL2: true, routeTier: () => "L2" });
    const { spec, trace } = await compose(GUI_INPUT, ctx);

    expect(trace.tier).toBe("L2");
    const sandbox = spec.components.find((c) => c.type === SANDBOX_HTML_TYPE);
    expect(sandbox).toBeDefined();
    expect(sandbox!.artifact?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sandbox!.artifact?.inline).toContain("kohaku.ready");
    expect(sandbox!.data?.$ref).toBe(REF);
    expect(spec.provenance.tier).toBe("L2");
    // <title> is reflected as the title in the heading (text.heading) and the sandbox props
    const heading = spec.components.find((c) => c.type === "text.heading");
    expect(heading?.props["text"]).toBe("Sales calendar heatmap");
  });
});

describe("compose: refVersions (per-reference dataVersion matching)", () => {
  const URI_A = "query://sales/summary?fy=2026&groupBy=region";
  const URI_B = "query://sales/kpi?fy=2026";

  /** A minimal L0 template with no data reference (refVersions comes from resolveRefs, so it is filled regardless of the composition) */
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

  function makeMultiCtx(handles: readonly { uri: string; version: string }[]): ComposeContext {
    return {
      catalog,
      semantic: makeMultiSemantic(handles),
      storage: makeStorage(),
      llm: new FakeLlm(),
      policy: { fixedSpecs: { lookup: async () => markdownFixed() } },
    };
  }

  it("when versions differ across multiple handles, dataVersion becomes multi: and refVersions holds each URI → its single version", async () => {
    const ctx = makeMultiCtx([
      { uri: URI_A, version: "sales@v1" },
      { uri: URI_B, version: "kpi@v2" },
    ]);
    const { spec } = await compose(GUI_INPUT, ctx);

    expect(spec.dataVersion.startsWith("multi:")).toBe(true);
    // Each $ref URI → the dataVersion of that reference alone (the renderer matches with this version)
    expect(spec.refVersions).toEqual({ [URI_A]: "sales@v1", [URI_B]: "kpi@v2" });
  });

  it("fills refVersions even for a single ref (to unify the renderer-side logic)", async () => {
    const ctx = makeMultiCtx([{ uri: URI_A, version: "sales@v1" }]);
    const { spec } = await compose(GUI_INPUT, ctx);

    // With a single version, dataVersion does not become multi: but is the single version itself
    expect(spec.dataVersion).toBe("sales@v1");
    expect(spec.refVersions).toEqual({ [URI_A]: "sales@v1" });
  });

  it("materializeFixation overwrites pinnedSpec's old refVersions with the latest versions", async () => {
    const pinned: UISpec = {
      ...markdownFixed(),
      dataVersion: "multi:stale",
      // The old version at fixation time (stale if the data has already been updated)
      refVersions: { [URI_A]: "sales@OLD", [URI_B]: "kpi@OLD" },
    };
    const fixation: FixationRecord = {
      intentHash: "sha256:" + "0".repeat(64),
      canonical: "x.y",
      pinnedSpec: pinned,
      structureHash: "sha256:" + "1".repeat(64),
      fixatedAt: "2026-06-10T00:00:00Z",
      approver: { id: "tester" },
    };
    const ctx = makeMultiCtx([
      { uri: URI_A, version: "sales@v1" },
      { uri: URI_B, version: "kpi@v2" },
    ]);
    const intent = { canonical: "x.y", params: {}, hash: pinned.intent.hash };
    const { result, check } = await materializeFixation(fixation, intent, ctx);

    // A record without a fingerprint enters the revalidation path, and since it is core components only it passes and is deliverable (revalidated)
    expect(check.kind).toBe("revalidated");
    expect(result).not.toBeNull();
    // Even a fixation delivery is updated to the latest per-reference versions (delivering with the old version would always be STALE)
    expect(result!.spec.refVersions).toEqual({ [URI_A]: "sales@v1", [URI_B]: "kpi@v2" });
    expect(result!.spec.dataVersion.startsWith("multi:")).toBe(true);
  });
});

describe("materializeFixation: staleness detection (FixationCheck)", () => {
  const URI = "query://sales/summary?fy=2026&groupBy=region";

  /** A valid pinnedSpec with core components only (passes validation) */
  function validPinned(): UISpec {
    return {
      kohaku: "0.1",
      intent: { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) },
      dataVersion: "pinned@v0",
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["md1"] },
        { id: "md1", type: "presentMarkdown", props: { markdown: "Pinned view" } },
      ],
      events: [],
      provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
    };
  }

  function makeCtx1(): ComposeContext {
    return {
      catalog,
      semantic: makeMultiSemantic([{ uri: URI, version: "sales@v1" }]),
      storage: makeStorage(),
      llm: new FakeLlm(),
      policy: {},
    };
  }

  function makeFixation(pinnedSpec: UISpec, catalogFingerprint?: string): FixationRecord {
    return {
      intentHash: pinnedSpec.intent.hash,
      canonical: pinnedSpec.intent.canonical,
      structureHash: "sha256:" + "1".repeat(64),
      pinnedSpec,
      fixatedAt: "2026-06-10T00:00:00Z",
      approver: { id: "tester" },
      ...(catalogFingerprint != null ? { catalogFingerprint } : {}),
    };
  }

  const intent = { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) };

  it("a fingerprint match is fresh (skips revalidation and is deliverable)", async () => {
    const ctx = makeCtx1();
    const fixation = makeFixation(validPinned(), ctx.catalog.fingerprint);
    const { result, check } = await materializeFixation(fixation, intent, ctx);

    expect(check.kind).toBe("fresh");
    expect(result).not.toBeNull();
    expect(result!.spec.provenance.cache).toBe("fixated");
  });

  it("a corrupted pinnedSpec (fails FixationRecordSchema) is stale even on a fingerprint match, and is not delivered", async () => {
    const ctx = makeCtx1();
    // components empty violates UISpecSchema's min(1) — a stand-in for a truncated/hand-edited fixations.json
    // entry. Fingerprint deliberately matches ctx.catalog.fingerprint, showing the schema check runs before
    // (and independently of) the fingerprint fast path.
    const corrupted = { ...validPinned(), components: [] } as unknown as UISpec;
    const fixation = makeFixation(corrupted, ctx.catalog.fingerprint);
    const { result, check } = await materializeFixation(fixation, intent, ctx);

    expect(check.kind).toBe("stale");
    expect(result).toBeNull();
    if (check.kind === "stale") {
      expect(check.issues.join(" ")).toContain("schema validation");
    }
  });

  it("even on a fingerprint mismatch, if it passes validation against the current catalog it is revalidated (deliverable)", async () => {
    const ctx = makeCtx1();
    const fixation = makeFixation(validPinned(), "sha256:stale-fingerprint");
    const { result, check } = await materializeFixation(fixation, intent, ctx);

    expect(check.kind).toBe("revalidated");
    expect(result).not.toBeNull();
    expect(result!.spec.provenance.cache).toBe("fixated");
  });

  it("a fingerprint mismatch + UNKNOWN_TYPE is stale (not deliverable, returns issues)", async () => {
    const ctx = makeCtx1();
    const pinned = validPinned();
    // Mimics a pinnedSpec containing a component that disappeared from the catalog after fixation (or was renamed)
    pinned.components = [
      { id: "root", type: "layout.stack", props: {}, children: ["ghost"] },
      { id: "ghost", type: "was.promoted.but.removed", props: {} },
    ];
    const fixation = makeFixation(pinned, "sha256:stale-fingerprint");
    const { result, check } = await materializeFixation(fixation, intent, ctx);

    expect(check.kind).toBe("stale");
    expect(result).toBeNull();
    if (check.kind === "stale") {
      expect(check.issues.length).toBeGreaterThan(0);
      expect(check.issues.join(" ")).toContain("ghost");
    }
  });

  it("a record missing a fingerprint (old format) enters the revalidation path", async () => {
    const ctx = makeCtx1();
    const fixation = makeFixation(validPinned()); // no catalogFingerprint
    const { result, check } = await materializeFixation(fixation, intent, ctx);

    // Since the fingerprint is undefined it never matches, so it always takes the validate path → passes since it is core components
    expect(check.kind).toBe("revalidated");
    expect(result).not.toBeNull();
  });

  it("even on a fingerprint match, if a component's $ref is not among the current resolved URIs it is stale (catching query-mapping drift)", async () => {
    const ctx = makeCtx1(); // resolveQuery returns only URI (1 item)
    // Mimics a pinnedSpec with a component whose $ref at fixation time is not contained in the current resolution result (URI).
    // Make catalogFingerprint match (fast path=fresh) to show that it is caught even with a fingerprint match.
    const orphan = "query://sales/legacy?fy=2025&groupBy=region";
    const pinned: UISpec = {
      ...validPinned(),
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["c1"] },
        { id: "c1", type: "presentChart", props: {}, data: { $ref: orphan } },
      ],
    };
    const fixation = makeFixation(pinned, ctx.catalog.fingerprint);
    const { result, check } = await materializeFixation(fixation, intent, ctx);

    expect(check.kind).toBe("stale");
    expect(result).toBeNull();
    if (check.kind === "stale") {
      expect(check.issues.join(" ")).toContain(orphan);
    }
  });

  it("when the resolved ref set grows (1→2), it is stale even on a fingerprint match (bidirectional multi-ref drift detection)", async () => {
    // pinnedSpec.refVersions represents the resolved set at fixation time ({URI} = 1 item).
    const pinned: UISpec = { ...validPinned(), refVersions: { [URI]: "sales@v0" } };
    // The current one resolves 2 refs (a situation where a ref increased via a code revision). Make
    // catalogFingerprint match to show that an add drift is caught even on the fingerprint fast path.
    const ctx: ComposeContext = {
      catalog,
      semantic: makeMultiSemantic([
        { uri: URI, version: "sales@v1" },
        { uri: "query://sales/kpi?fy=2026", version: "kpi@v1" },
      ]),
      storage: makeStorage(),
      llm: new FakeLlm(),
      policy: {},
    };
    const fixation = makeFixation(pinned, ctx.catalog.fingerprint);
    const { result, check } = await materializeFixation(fixation, intent, ctx);

    expect(check.kind).toBe("stale");
    expect(result).toBeNull();
    if (check.kind === "stale") {
      // Include the direction (added) and the added URI in the stale detail
      expect(check.issues.join(" ")).toContain("added");
      expect(check.issues.join(" ")).toContain("query://sales/kpi?fy=2026");
    }
  });

  it("when the resolved ref set shrinks (2→1), it is also stale on a fingerprint match (makes the removed direction explicit)", async () => {
    const uriB = "query://sales/kpi?fy=2026";
    // pinnedSpec.refVersions represents the resolved set at fixation time ({URI, uriB} = 2 items).
    const pinned: UISpec = { ...validPinned(), refVersions: { [URI]: "sales@v0", [uriB]: "kpi@v0" } };
    // The current one resolves only 1 ref (a situation where a ref decreased via a code revision). makeCtx1's resolveQuery returns URI (1 item).
    // Make catalogFingerprint match to show that a removal drift is caught even on the fingerprint fast path.
    const ctx = makeCtx1();
    const fixation = makeFixation(pinned, ctx.catalog.fingerprint);
    const { result, check } = await materializeFixation(fixation, intent, ctx);

    expect(check.kind).toBe("stale");
    expect(result).toBeNull();
    if (check.kind === "stale") {
      // Include the direction (removed) and the disappeared URI in the stale detail (symmetric with the added 1→2 test)
      expect(check.issues.join(" ")).toContain("removed");
      expect(check.issues.join(" ")).toContain(uriB);
    }
  });
});

describe("recompose (interaction loop)", () => {
  it("an Intent diff → returns a new Spec + an applicable SpecPatch", async () => {
    const drill = goodRawDraft("query://sales/summary?fy=2026&groupBy=region&q=4") as {
      components: { id: string; type: string; props: Record<string, unknown> }[];
    };
    const llm = new FakeLlm({ objects: [goodRawDraft(), drill] });
    const ctx = makeCtx(llm);

    const first = await compose(GUI_INPUT, ctx);
    const { result, patch } = await recompose(first.spec, { params: { quarter: 4 } }, ctx);

    expect(result.spec.intent.params["quarter"]).toBe(4);
    expect(result.spec.intent.hash).not.toBe(first.spec.intent.hash);
    expect(patch.intent?.hash).toBe(result.spec.intent.hash);
    expect(applyPatch(first.spec, patch)).toEqual(result.spec);
  });
});

/** An L0 fixed template (a minimal Spec with no data reference). */
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

describe("compose: generatorVersion (cache generation separation)", () => {
  it("changing generatorVersion makes the 2nd a cache miss too (key separation)", async () => {
    const storage = makeStorage();
    const llm = new FakeLlm({ objects: [goodRawDraft(), goodRawDraft()] });
    const ctxV1: ComposeContext = {
      catalog,
      semantic: makeSemantic(),
      storage,
      llm,
      policy: { generatorVersion: "p1/m" },
    };
    const ctxV2: ComposeContext = { ...ctxV1, policy: { generatorVersion: "p2/m" } };

    const first = await compose(GUI_INPUT, ctxV1);
    const second = await compose(GUI_INPUT, ctxV2);

    expect(first.trace.cache).toBe("miss");
    // A different generator version = a different key, so it is regenerated (prevents a display flip-flop)
    expect(second.trace.cache).toBe("miss");
    expect(first.trace.cacheKey).not.toBe(second.trace.cacheKey);
    expect(first.trace.cacheKey.endsWith(":p1/m")).toBe(true);
    expect(second.trace.cacheKey.endsWith(":p2/m")).toBe(true);
    expect(llm.calls).toHaveLength(2);
  });

  it("when generatorVersion is unspecified, the 2nd hits under the conventional key (backward compatible)", async () => {
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    const ctx = makeCtx(llm); // no generatorVersion in policy
    const first = await compose(GUI_INPUT, ctx);
    const second = await compose(GUI_INPUT, ctx);

    expect(first.trace.cache).toBe("miss");
    expect(second.trace.cache).toBe("hit");
    expect(llm.calls).toHaveLength(1);
    // The conventional 5-component key (no generatorVersion component appended at the end)
    expect(first.trace.cacheKey).not.toMatch(/:p\d+\//);
  });
});

describe("compose: single-flight (concurrent coalescing)", () => {
  it("concurrent composes of the same key generate only once and one becomes coalesced", async () => {
    const gated = makeGatedLlm();
    const { ctx, getCacheReads } = makeCountingCtx(gated.llm);

    const p = Promise.all([compose(GUI_INPUT, ctx), compose(GUI_INPUT, ctx)]);
    await waitUntil(() => getCacheReads() >= 2); // both reach the cache lookup (synchronously registered immediately after)
    await tick(); // registration complete + the leader stopped at the LLM gate
    expect(gated.callCount()).toBe(1); // only the leader has reached the LLM
    gated.release();
    const [a, b] = await p;

    expect(gated.callCount()).toBe(1); // the follower does not call the LLM
    // The outputs (components / events) match exactly
    expect(a.spec.components).toEqual(b.spec.components);
    expect(a.spec.events).toEqual(b.spec.events);
    // Exactly one is the follower (coalesced:true / empty attempts / hit relabel)
    const coalesced = [a, b].filter((r) => r.trace.coalesced === true);
    expect(coalesced).toHaveLength(1);
    expect(coalesced[0]!.trace.attempts).toEqual([]);
    expect(coalesced[0]!.trace.cache).toBe("hit");
    expect(coalesced[0]!.spec.provenance.cache).toBe("hit");
  });

  it("the leader's abort does not propagate to a healthy follower (generation stops only when everyone aborts)", async () => {
    const gated = makeGatedLlm();
    const { ctx, getCacheReads } = makeCountingCtx(gated.llm);

    const leaderController = new AbortController();
    const pLeader = compose(GUI_INPUT, ctx, { abort: leaderController.signal });
    const pFollower = compose(GUI_INPUT, ctx); // the follower does not abort
    await waitUntil(() => getCacheReads() >= 2); // both reach the cache lookup (synchronously registered immediately after)
    await tick(); // registration complete + the leader stopped at the LLM gate
    expect(gated.callCount()).toBe(1);

    // Only the leader's client disconnects. Because a waiter (the follower) remains, the shared generation is not aborted.
    leaderController.abort();
    gated.release();
    const [leader, follower] = await Promise.all([pLeader, pFollower]);

    // The follower receives a normal generation result (does not ride along on a fallback screen caused by someone else's abort).
    expect(follower.spec.provenance.fallback).toBeUndefined();
    expect(follower.spec.provenance.tier).toBe("L1");
    // The leader itself also receives the completed result (its response destination is lost, but generation ran to completion).
    expect(leader.spec.provenance.fallback).toBeUndefined();
  });

  it("concurrent composes of different keys do not coalesce and each generates", async () => {
    const gated = makeGatedLlm();
    const { ctx, getCacheReads } = makeCountingCtx(gated.llm);
    const inputB: GuiAction = {
      kind: "gui",
      action: "facet.change",
      params: { fiscalYear: 2026, quarter: 4, groupBy: "region" },
    };

    const p = Promise.all([compose(GUI_INPUT, ctx), compose(inputB, ctx)]);
    await waitUntil(() => getCacheReads() >= 2);
    await tick();
    expect(gated.callCount()).toBe(2); // different keys, so both reach the LLM as leaders
    gated.release();
    const [a, b] = await p;

    expect(a.trace.cacheKey).not.toBe(b.trace.cacheKey);
    expect(a.trace.coalesced).toBeUndefined();
    expect(b.trace.coalesced).toBeUndefined();
  });

  it("the leader's throw propagates to the follower too, and the in-flight table is cleaned up", async () => {
    const boom = new Error("generation failed(test)");
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((r) => {
      releaseLookup = r;
    });
    let mode: "throw" | "ok" = "throw";
    // Stop the leader after registration at the lookup gate, and make it throw after waiting for the follower's registration.
    const { ctx, getCacheReads } = makeCountingCtx(new FakeLlm(), {
      fixedSpecs: {
        lookup: async () => {
          await lookupGate;
          if (mode === "throw") throw boom;
          return markdownFixed();
        },
      },
    });

    const results = Promise.all([
      compose(GUI_INPUT, ctx).catch((e) => e),
      compose(GUI_INPUT, ctx).catch((e) => e),
    ]);
    await waitUntil(() => getCacheReads() >= 2); // both reach the cache lookup
    await tick(); // registration complete (the leader stopped at the lookup gate)
    releaseLookup();
    const [a, b] = await results;

    expect(a).toBe(boom); // the leader's throw
    expect(b).toBe(boom); // propagated to the follower too

    // If the table is cleaned up, the next compose of the same key succeeds as a new leader
    // (if it remained, it would await the already-rejected Promise and throw boom)
    mode = "ok";
    const third = await compose(GUI_INPUT, ctx);
    expect(third.spec.provenance.tier).toBe("L0");
    expect(third.trace.coalesced).toBeUndefined();
  });

  it("on the fallback path the follower does not turn into a hit either (keeps the leader's label)", async () => {
    // Always an invalid draft → L1 is exhausted and falls to the deterministic fallback
    const gated = makeGatedLlm(() => ({ components: [], events: [] }));
    const { ctx, getCacheReads } = makeCountingCtx(gated.llm);

    const p = Promise.all([compose(GUI_INPUT, ctx), compose(GUI_INPUT, ctx)]);
    await waitUntil(() => getCacheReads() >= 2);
    await tick(); // the leader stopped at the first LLM gate; the follower is registered
    expect(gated.callCount()).toBe(1);
    gated.release();
    const [a, b] = await p;

    const follower = [a, b].find((r) => r.trace.coalesced === true);
    expect(follower).toBeDefined();
    expect(follower!.spec.provenance.fallback).toBeDefined();
    // A fallback does not pretend to be a hit: cache stays miss
    expect(follower!.spec.provenance.cache).toBe("miss");
    expect(follower!.trace.cache).toBe("miss");
    // The follower has empty attempts but inherits the fallback reason
    expect(follower!.trace.attempts).toEqual([]);
    expect(follower!.trace.fallback?.reason).toContain("L1");
  });

  it("after the leader aborts alone, the in-flight entry is removed and a later compose generates anew (two generations observed)", async () => {
    // A single gate shared by every call: throws ABORTED once released if the request's signal is by then
    // aborted, otherwise returns a good draft. Lets both the leader's (aborted) call and a later caller's
    // (fresh) call be released together, while still distinguishing which one saw the abort.
    const gated = makeGatedLlm((req) => {
      if (req.abort?.aborted === true) throw new LlmError("ABORTED", "aborted(test)");
      return goodRawDraft(refFromPrompt(req.prompt));
    });
    const { ctx, getCacheReads } = makeCountingCtx(gated.llm);

    const leaderController = new AbortController();
    const pLeader = compose(GUI_INPUT, ctx, { abort: leaderController.signal });
    await waitUntil(() => getCacheReads() >= 1);
    await tick(); // the leader is registered and stopped at the LLM gate
    expect(gated.callCount()).toBe(1);

    // The leader is the sole waiter, so aborting immediately votes the shared generation down. The
    // in-flight entry must be removed right away (not only once the doomed promise later settles) —
    // otherwise a caller arriving in this exact window would be coalesced onto a cancelled result.
    leaderController.abort();

    // A second caller for the same key arrives before the gate is released (before the first call has
    // even settled). If the entry were still in the table, this would ride along on the leader's
    // (about-to-be-cancelled) result instead of starting its own generation.
    const pLater = compose(GUI_INPUT, ctx);
    // The later caller reaches the LLM gate only after its own prepare/cache-read steps, which take more
    // than one microtask tick under full-suite load — wait for the second call rather than a fixed tick.
    await waitUntil(() => gated.callCount() >= 2);
    expect(gated.callCount()).toBe(2); // the later caller became a fresh leader, not a follower

    gated.release();
    const [leaderResult, laterResult] = await Promise.all([pLeader, pLater]);

    expect(leaderResult.spec.provenance.fallback).toBeDefined();
    expect(leaderResult.trace.cancelled).toBe(true);
    expect(laterResult.spec.provenance.fallback).toBeUndefined();
    expect(laterResult.trace.coalesced).toBeUndefined();
  });
});

describe("compose: trace.usage (sum of attempts)", () => {
  it("when the repair loop has 2 attempts, sums the usage", async () => {
    const bad = { components: [], events: [] }; // the 1st fails validation
    const llm = makeUsageLlm(
      [bad, goodRawDraft()],
      [
        { inputTokens: 10, outputTokens: 5 },
        { inputTokens: 20, outputTokens: 7 },
      ],
    );
    const { trace } = await compose(GUI_INPUT, makeCtx(llm));

    expect(trace.attempts).toHaveLength(2);
    expect(trace.usage).toEqual({ inputTokens: 30, outputTokens: 12 });
  });

  it("on the L0 path (no LLM call), usage is not set", async () => {
    const ctx = makeCtx(new FakeLlm(), { fixedSpecs: { lookup: async () => markdownFixed() } });
    const { trace } = await compose(GUI_INPUT, ctx);

    expect(trace.tier).toBe("L0");
    expect(trace.usage).toBeUndefined();
  });
});

describe("recompose: respectPrevTier", () => {
  const prevL2: UISpec = {
    kohaku: "0.1",
    intent: {
      canonical: "sales.quarterly_summary",
      params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
      hash: "sha256:" + "a".repeat(64),
    },
    dataVersion: "sales@seed-1",
    components: [
      {
        id: "root",
        type: "layout.stack",
        props: { direction: "vertical", gap: "md" },
        children: ["sandbox1"],
      },
      {
        id: "sandbox1",
        type: SANDBOX_HTML_TYPE,
        props: { title: "original widget" },
        artifact: { inline: "<!DOCTYPE html><html></html>", sha256: "0".repeat(64) },
      },
    ],
    events: [],
    provenance: { tier: "L2", composedBy: "test", cache: "miss" },
  };

  const l2Html =
    "<!DOCTYPE html><html><head><title>Updated widget</title></head><body><script>window.kohaku.ready()</script></body></html>";

  it("with respectPrevTier:true and prev being L2, a diff update also enters the L2 path (raw HTML generation)", async () => {
    const llm = new FakeLlm({ texts: [l2Html] });
    // routeTier unspecified = default L1. Verifies that respectPrevTier overrides to L2
    const ctx = makeCtx(llm, { allowL2: true });
    const { result } = await recompose(prevL2, { params: { quarter: 4 } }, ctx, {
      respectPrevTier: true,
    });

    expect(result.spec.provenance.tier).toBe("L2");
    // L2 is the generateText (raw HTML) path. Distinguishable from L1 (ui_spec_draft's generateObject).
    expect(llm.calls[0]!.kind).toBe("text");
  });

  it("by default (respectPrevTier unspecified), enters the L1 path (ui_spec_draft)", async () => {
    const good = goodRawDraft("query://sales/summary?fy=2026&groupBy=region&q=4");
    const llm = new FakeLlm({ objects: [good] });
    const ctx = makeCtx(llm, { allowL2: true });
    const { result } = await recompose(prevL2, { params: { quarter: 4 } }, ctx);

    expect(result.spec.provenance.tier).toBe("L1");
    expect(llm.calls[0]!.schemaName).toBe("ui_spec_draft");
  });

  it("respectPrevTier wins when ctx.policyFor is wired (session policy resolved first, override layered on top; generatorVersion from policyFor is retained)", async () => {
    const llm = new FakeLlm({ texts: [l2Html] });
    // policyFor resolves a session policy that itself defaults to L1 (routeTier unspecified) and carries
    // its own generatorVersion. Without layering the override after withSessionPolicy, respectPrevTier's
    // L2 pin would be silently discarded by this wholesale policy replacement.
    const ctx: ComposeContext = {
      ...makeCtx(llm, { allowL2: true }),
      policyFor: () => ({ allowL2: true, generatorVersion: "session-policy-v1" }),
    };
    const { result } = await recompose(prevL2, { params: { quarter: 4 } }, ctx, {
      respectPrevTier: true,
    });

    // Still routed to L2 despite policyFor resolving its own (L1-default) policy.
    expect(result.spec.provenance.tier).toBe("L2");
    expect(llm.calls[0]!.kind).toBe("text");
    // The session policy's generatorVersion is preserved (spread order keeps it, only routeTier/allowL2 change).
    expect(result.trace.cacheKey.endsWith(":session-policy-v1")).toBe(true);
  });
});

const L2_TEXT =
  "<!DOCTYPE html><html><head><title>Sales widget</title></head><body><script>window.kohaku.ready()</script></body></html>";

/** An LlmPort stub that always throws an LlmError of the given code (exposes the call count). */
function makeThrowingLlm(code: "ABORTED" | "PROVIDER" | "INVALID_OUTPUT"): {
  llm: LlmPort;
  callCount: () => number;
} {
  let calls = 0;
  const llm: LlmPort = {
    provider: "throwing",
    modelId: "throwing-model",
    async generateObject<T>(): Promise<GenerateObjectResult<T>> {
      calls += 1;
      throw new LlmError(code, `${code}(test)`);
    },
    async generateText() {
      throw new Error("throwing stub: generateText not supported");
    },
  };
  return { llm, callCount: () => calls };
}

describe("compose: L1 failure kinds and L2 promotion", () => {
  it("when L1 is ABORTED, does not route to L2 even with allowL2=true and falls back immediately, marked cancelled (not a transient generation failure)", async () => {
    const { llm, callCount } = makeThrowingLlm("ABORTED");
    const { spec, trace } = await compose(GUI_INPUT, makeCtx(llm, { allowL2: true }));

    // L1 ABORTED once → no L2 promotion (only 1 generation call) and falls to the fallback
    expect(callCount()).toBe(1);
    expect(spec.provenance.tier).toBe("L1");
    expect(spec.provenance.fallback?.from).toBe("L1");
    // ABORTED is classified separately from a transient provider failure: the reason reflects a
    // cancellation, not a skipped L2 promotion, and the trace is marked cancelled so hosts do not
    // count it as a generation fallback.
    expect(trace.fallback?.reason).toContain("cancelled");
    expect(trace.cancelled).toBe(true);
    // No repair re-attempt either (aborted exits in 1 attempt)
    expect(trace.attempts).toHaveLength(1);
  });

  it("when L1 is transient (PROVIDER), also does not route to L2 (avoiding a double full generation on a provider failure)", async () => {
    const { llm, callCount } = makeThrowingLlm("PROVIDER");
    const { spec } = await compose(GUI_INPUT, makeCtx(llm, { allowL2: true }));

    expect(callCount()).toBe(1);
    expect(spec.provenance.fallback?.from).toBe("L1");
  });

  it("when L1 is invalid (validation failure), promotes to L2 with allowL2=true (happy-path invariance)", async () => {
    // empty components = catalog/structural-validation failure (INVALID kind). Fails twice (initial + repair), then L2 (texts).
    const empty = { components: [], events: [] };
    const llm = new FakeLlm({ objects: [empty, empty], texts: [L2_TEXT] });
    const { spec } = await compose(GUI_INPUT, makeCtx(llm, { allowL2: true }));

    // An invalid failure is promoted to L2 (tier=L2, the sandbox component is generated)
    expect(spec.provenance.tier).toBe("L2");
    expect(spec.components.some((c) => c.type === SANDBOX_HTML_TYPE)).toBe(true);
    // L1 initial + 1 repair + L2 once = 3 times
    expect(llm.calls).toHaveLength(3);
  });
});

describe("compose: abort-signal passthrough", () => {
  /** An LlmPort stub that records req.abort and throws ABORTED if already aborted. */
  function makeAbortAwareLlm(): { llm: LlmPort; seenSignals: () => (AbortSignal | undefined)[] } {
    const seen: (AbortSignal | undefined)[] = [];
    const llm: LlmPort = {
      provider: "abort-aware",
      modelId: "abort-model",
      async generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
        seen.push(req.abort);
        if (req.abort?.aborted === true) throw new LlmError("ABORTED", "aborted(test)");
        return {
          object: goodRawDraft(refFromPrompt(req.prompt)) as T,
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "abort-model",
        };
      },
      async generateText() {
        throw new Error("abort-aware stub: generateText not supported");
      },
    };
    return { llm, seenSignals: () => seen };
  }

  it("passing an already-aborted signal passes through to L1 and falls back immediately without a repair retry", async () => {
    const { llm, seenSignals } = makeAbortAwareLlm();
    const controller = new AbortController();
    controller.abort(); // request already abandoned

    const { spec, trace } = await compose(GUI_INPUT, makeCtx(llm), {
      abort: controller.signal,
    });

    // The abort passes through to the LLM call. Because single-flight's vote-based cancel (shared
    // AbortController) is interposed it is not the same reference, but if the caller is the only waiter the abort propagates to the shared signal immediately.
    expect(seenSignals()[0]?.aborted).toBe(true);
    // ABORTED exits in one attempt (no repair re-attempt = prevents continuing full generation of an abandoned request)
    expect(seenSignals()).toHaveLength(1);
    expect(trace.attempts).toHaveLength(1);
    expect(trace.attempts[0]!.ok).toBe(false);
    expect(spec.provenance.fallback?.from).toBe("L1");
  });

  it("an already-aborted signal yields a fallback with trace.cancelled=true and observer.onError phase 'cancelled' (not 'fallback')", async () => {
    const captured: ComposeErrorContext[] = [];
    const { llm } = makeAbortAwareLlm();
    const controller = new AbortController();
    controller.abort();
    const ctx: ComposeContext = {
      ...makeCtx(llm),
      observer: {
        onError: (c) => {
          captured.push(c);
        },
      },
    };

    const { spec, trace } = await compose(GUI_INPUT, ctx, { abort: controller.signal });

    expect(spec.provenance.fallback?.from).toBe("L1");
    expect(trace.cancelled).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.phase).toBe("cancelled");
  });

  it("when abort is unspecified, req.abort is not passed (backward compatible)", async () => {
    const { llm, seenSignals } = makeAbortAwareLlm();
    const { spec } = await compose(GUI_INPUT, makeCtx(llm));

    // When signal is unspecified it is undefined (the conventional behavior equivalent to FakeLlm). Generation succeeds.
    expect(seenSignals()[0]).toBeUndefined();
    expect(spec.provenance.tier).toBe("L1");
    expect(spec.provenance.fallback).toBeUndefined();
  });
});

describe("compose: observability of the failure path (observer.onError, #7)", () => {
  type Captured = { ctx: ComposeErrorContext; error: unknown };

  it("on a hard failure (a reference-resolution exception), onError(phase:hard) is called and the exception is re-thrown", async () => {
    const captured: Captured[] = [];
    const semantic = makeSemantic();
    semantic.resolveQuery = async () => {
      throw new Error("reference resolution failed(test)");
    };
    const ctx: ComposeContext = {
      catalog,
      semantic,
      storage: makeStorage(),
      llm: new FakeLlm(),
      observer: {
        onError: (c, error) => {
          captured.push({ ctx: c, error });
        },
      },
    };

    await expect(compose(GUI_INPUT, ctx)).rejects.toThrow(/query resolution failed/);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.ctx.phase).toBe("hard");
    expect(captured[0]!.error).toBeInstanceOf(Error);
  });

  it("on the deterministic downgrade from a generation failure, onError(phase:fallback) is called once with the reason and intent", async () => {
    const captured: Captured[] = [];
    const bad = { components: [], events: [] };
    const llm = new FakeLlm({ objects: [bad, bad] });
    const ctx: ComposeContext = {
      ...makeCtx(llm),
      observer: {
        onError: (c, error) => {
          captured.push({ ctx: c, error });
        },
      },
    };

    const { spec } = await compose(GUI_INPUT, ctx);
    expect(spec.provenance.fallback?.from).toBe("L1");

    expect(captured).toHaveLength(1);
    expect(captured[0]!.ctx.phase).toBe("fallback");
    expect(captured[0]!.ctx.reason).toContain("L1");
    expect(captured[0]!.ctx.intent).toBeDefined();
    expect(captured[0]!.ctx.cacheKey).toBeDefined();
    // A fallback involves no exception throwing, so error is undefined (the information is in ctx.reason)
    expect(captured[0]!.error).toBeUndefined();
  });

  it("a normal compose does not call onError", async () => {
    const captured: Captured[] = [];
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    const ctx: ComposeContext = {
      ...makeCtx(llm),
      observer: {
        onError: (c, error) => {
          captured.push({ ctx: c, error });
        },
      },
    };

    const { spec } = await compose(GUI_INPUT, ctx);
    expect(spec.provenance.fallback).toBeUndefined();
    expect(captured).toHaveLength(0);
  });

  it("even if onError throws, it does not affect compose's error/result (observation only)", async () => {
    const bad = { components: [], events: [] };
    const llm = new FakeLlm({ objects: [bad, bad] });
    const ctx: ComposeContext = {
      ...makeCtx(llm),
      observer: {
        onError: () => {
          throw new Error("error inside observer hook");
        },
      },
    };

    // Even if the hook throws, compose returns the fallback Spec normally
    const { spec } = await compose(GUI_INPUT, ctx);
    expect(spec.provenance.fallback?.from).toBe("L1");
  });
});

describe("compose: defense against malformed L1 drafts", () => {
  it("even if components is non-array (e.g. 5), does not throw, attempts repair, and ultimately falls back", async () => {
    const bad = { components: 5, events: [] };
    const llm = new FakeLlm({ objects: [bad, bad] });
    const { spec, trace } = await compose(GUI_INPUT, makeCtx(llm));

    // decode's defensive throw does not become a hard exception (INTERNAL / host 500) but rides the repair loop
    expect(spec.components.map((c) => c.type)).toEqual(["layout.stack", "presentMarkdown"]);
    expect(spec.provenance.fallback?.from).toBe("L1");
    expect(trace.attempts).toHaveLength(2);
    expect(trace.attempts.every((a) => a.ok === false)).toBe(true);
    // decode's error is recorded as a repair issue
    expect(trace.attempts[0]!.issues!.join(" ")).toContain("array");
    expect(llm.calls).toHaveLength(2);
  });

  it('even if events contains a string element (events:["string"]), does not throw and falls to the fallback', async () => {
    const bad = {
      components: [{ id: "root", type: "layout.stack", props: {} }],
      events: ["string"],
    };
    const llm = new FakeLlm({ objects: [bad, bad] });
    const { spec } = await compose(GUI_INPUT, makeCtx(llm));

    // Guards against a malformed events entry turning into a TypeError at catalog.validate's on.split (INTERNAL).
    expect(spec.provenance.fallback?.from).toBe("L1");
    expect(spec.components.map((c) => c.type)).toEqual(["layout.stack", "presentMarkdown"]);
  });

  it("an out-of-enum emit is sent back by collectIssues' Zod validation and falls back without becoming INTERNAL", async () => {
    // decode passes (emit is a string). It also slips past catalog/structural validation, but the EventBinding Zod rejects it.
    // Guards against reaching the final parseSpec Zod and becoming ComposeError("INTERNAL").
    const bad = {
      components: [
        {
          id: "root",
          type: "layout.stack",
          props: { direction: "vertical", gap: null },
          children: ["t"],
        },
        { id: "t", type: "presentSpreadsheet", props: { editable: false }, data: { $ref: REF } },
      ],
      events: [{ on: "t.rowClick", emit: "intent.nope", payload: [{ key: "k", value: "v" }] }],
    };
    const llm = new FakeLlm({ objects: [bad, bad] });
    const { spec, trace } = await compose(GUI_INPUT, makeCtx(llm));

    expect(spec.provenance.fallback?.from).toBe("L1");
    expect(trace.attempts[0]!.issues!.join(" ")).toContain("EVENT_INVALID");
  });

  it("succeeds if the correct shape is returned on the 2nd repair (malformed → well-formed)", async () => {
    const bad = { components: 5, events: [] };
    const llm = new FakeLlm({ objects: [bad, goodRawDraft()] });
    const { spec, trace } = await compose(GUI_INPUT, makeCtx(llm));

    expect(spec.provenance.tier).toBe("L1");
    expect(spec.provenance.fallback).toBeUndefined();
    expect(trace.attempts).toHaveLength(2);
    expect(trace.attempts[0]!.ok).toBe(false);
    expect(trace.attempts[1]!.ok).toBe(true);
    // The repair feedback appears in the 2nd prompt
    expect(llm.calls[1]!.prompt).toContain("Problems in the previous generation");
  });
});

describe("compose: state carry-over of the L0 fixed template", () => {
  it("a fixed template with state + visibleWhen can be composed, and state remains in the delivered Spec", async () => {
    const fixed: UISpec = {
      kohaku: "0.2",
      intent: { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) },
      dataVersion: "ignored",
      state: { showDetail: false },
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["md1", "detail1"] },
        { id: "md1", type: "presentMarkdown", props: { markdown: "Overview" } },
        {
          id: "detail1",
          type: "presentMarkdown",
          props: { markdown: "Detail" },
          visibleWhen: { ref: "$state.showDetail", eq: true },
        },
      ],
      events: [],
      provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
    };
    const ctx = makeCtx(new FakeLlm(), { fixedSpecs: { lookup: async () => fixed } });
    // Dropping state makes visibleWhen STATE_REF_UNKNOWN → reject with ComposeError("INTERNAL").
    // This passing as resolves is itself the regression check for state carry-over.
    const { spec, trace } = await compose(GUI_INPUT, ctx);

    expect(trace.tier).toBe("L0");
    expect(spec.provenance.tier).toBe("L0");
    // The initial state remains in the delivered Spec (symmetric with materializeFixation's state preservation)
    expect(spec.state).toEqual({ showDetail: false });
    const detail = spec.components.find((c) => c.visibleWhen != null);
    expect(detail?.visibleWhen).toEqual({ ref: "$state.showDetail", eq: true });
  });
});

describe("compose: observer hook throw/reject does not affect compose", () => {
  /** Collects unhandledRejection during fn execution (flushes 2 macrotasks after fn to surface unhandled rejections). */
  async function collectUnhandled(fn: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const handler = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on("unhandledRejection", handler);
    try {
      await fn();
      await tick();
      await tick();
    } finally {
      process.off("unhandledRejection", handler);
    }
    return seen;
  }

  it("a synchronously throwing onComposed does not affect the compose result (does not reject)", async () => {
    let called = false;
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    const ctx: ComposeContext = {
      ...makeCtx(llm),
      observer: {
        onComposed: () => {
          called = true;
          throw new Error("onComposed sync throw(test)");
        },
      },
    };
    const unhandled = await collectUnhandled(async () => {
      const { spec } = await compose(GUI_INPUT, ctx);
      // Even if the hook throws, compose returns a normal L1 Spec (does not reject)
      expect(spec.provenance.tier).toBe("L1");
      expect(spec.provenance.fallback).toBeUndefined();
    });
    expect(called).toBe(true);
    expect(unhandled).toEqual([]);
  });

  it("a rejecting onComposed does not produce an unhandledRejection", async () => {
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    const ctx: ComposeContext = {
      ...makeCtx(llm),
      observer: {
        onComposed: async () => {
          throw new Error("onComposed async reject(test)");
        },
      },
    };
    const unhandled = await collectUnhandled(async () => {
      const { spec } = await compose(GUI_INPUT, ctx);
      expect(spec.provenance.tier).toBe("L1");
    });
    expect(unhandled).toEqual([]);
  });

  it("a rejecting onError also does not affect the compose result / unhandledRejection", async () => {
    const bad = { components: [], events: [] };
    const llm = new FakeLlm({ objects: [bad, bad] });
    const ctx: ComposeContext = {
      ...makeCtx(llm),
      observer: {
        onError: async () => {
          throw new Error("onError async reject(test)");
        },
      },
    };
    const unhandled = await collectUnhandled(async () => {
      const { spec } = await compose(GUI_INPUT, ctx);
      expect(spec.provenance.fallback?.from).toBe("L1");
    });
    expect(unhandled).toEqual([]);
  });
});

describe("compose: the fallback's from is the tier that actually failed", () => {
  it("when L2 generation fails under routeTier=L2, fallback.from / tier become L2 (not mis-recorded as L1)", async () => {
    // Since route=L2, L1 does not run. L2 fails once in a single generation → deterministic fallback.
    const llm = new FakeLlm({
      objects: () => {
        throw new LlmError("INVALID_OUTPUT", "L2 generation failed(test)");
      },
    });
    const { spec, trace } = await compose(GUI_INPUT, makeCtx(llm, { allowL2: true, routeTier: () => "L2" }));

    expect(spec.provenance.fallback).toBeDefined();
    // What actually failed is L2. provenance.tier / fallback.from / trace.tier all become L2
    expect(spec.provenance.fallback?.from).toBe("L2");
    expect(spec.provenance.tier).toBe("L2");
    expect(trace.tier).toBe("L2");
  });
});

describe("compose: the L2 prompt presents only primaryRef", () => {
  it("even for an Intent that resolves 2 handles, the 2nd URI is not included in the L2 prompt", async () => {
    const URI_A = "query://sales/summary?fy=2026&groupBy=region";
    const URI_B = "query://sales/kpi?fy=2026";
    const llm = new FakeLlm({
      texts: [
        "<!DOCTYPE html><html><body><script>window.kohaku.fetchData('" +
          URI_A +
          "');window.kohaku.ready()</script></body></html>",
      ],
    });
    const ctx: ComposeContext = {
      catalog,
      semantic: makeMultiSemantic([
        { uri: URI_A, version: "a@1" },
        { uri: URI_B, version: "b@1" },
      ]),
      storage: makeStorage(),
      llm,
      policy: { allowL2: true, routeTier: () => "L2" },
    };
    const { spec } = await compose(GUI_INPUT, ctx);

    expect(spec.provenance.tier).toBe("L2");
    const l2Prompt = llm.calls[0]!.prompt;
    // primaryRef (uris[0]) is presented as "available"
    expect(l2Prompt).toContain(URI_A);
    // The second is outside the sandbox allowlist, so it is also excluded from the prompt (prevents runtime ERR_REF_NOT_ALLOWED)
    expect(l2Prompt).not.toContain(URI_B);
    // The sandbox node's data.$ref is also primaryRef only (the prompt and allowlist contract match)
    const sandbox = spec.components.find((c) => c.type === SANDBOX_HTML_TYPE);
    expect(sandbox!.data?.$ref).toBe(URI_A);
  });
});

describe("compose: Spec cache fail-open (cacheFailure policy)", () => {
  it("getSpecCache throwing is treated as a miss, onError phase 'cache', a Spec is still delivered", async () => {
    const captured: { ctx: ComposeErrorContext; error: unknown }[] = [];
    const base = makeStorage();
    const storage = {
      ...base,
      async getSpecCache(): Promise<UISpec | null> {
        throw new Error("cache backend unavailable(test)");
      },
    };
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    const ctx: ComposeContext = {
      catalog,
      semantic: makeSemantic(),
      storage,
      llm,
      observer: {
        onError: (c, error) => {
          captured.push({ ctx: c, error });
        },
      },
    };

    const { spec, trace } = await compose(GUI_INPUT, ctx);

    // A miss on a throwing lookup still generates and delivers normally.
    expect(spec.provenance.fallback).toBeUndefined();
    expect(trace.cache).toBe("miss");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.ctx.phase).toBe("cache");
    expect(captured[0]!.error).toBeInstanceOf(Error);
  });

  it("putSpecCache throwing does not block delivery", async () => {
    const captured: { ctx: ComposeErrorContext; error: unknown }[] = [];
    const base = makeStorage();
    const storage = {
      ...base,
      async putSpecCache(): Promise<void> {
        throw new Error("cache backend unavailable(test)");
      },
    };
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    const ctx: ComposeContext = {
      catalog,
      semantic: makeSemantic(),
      storage,
      llm,
      observer: {
        onError: (c, error) => {
          captured.push({ ctx: c, error });
        },
      },
    };

    const { spec } = await compose(GUI_INPUT, ctx);

    expect(spec.provenance.fallback).toBeUndefined();
    expect(base.specCache.size).toBe(0); // the store itself failed, so nothing landed
    expect(captured).toHaveLength(1);
    expect(captured[0]!.ctx.phase).toBe("cache");
  });

  it("cacheFailure:'closed' rethrows the storage error", async () => {
    const base = makeStorage();
    const storage = {
      ...base,
      async getSpecCache(): Promise<UISpec | null> {
        throw new Error("cache backend unavailable(test)");
      },
    };
    const llm = new FakeLlm({ objects: [goodRawDraft()] });
    const ctx: ComposeContext = {
      catalog,
      semantic: makeSemantic(),
      storage,
      llm,
      policy: { cacheFailure: "closed" },
    };

    await expect(compose(GUI_INPUT, ctx)).rejects.toThrow(/cache backend unavailable/);
  });
});

import type { LlmPort } from "@kohaku-ui/llm";
import { LlmError } from "@kohaku-ui/llm";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { GuiAction } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type ComposeContext, type ComposeErrorContext, compose, type TraceContext } from "../src/index.js";
import { catalog, goodRawDraft, makeSemantic, makeStorage } from "./helpers.js";

const GUI_INPUT: GuiAction = {
  kind: "gui",
  action: "facet.change",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
};

const SAMPLE_TRACE_CONTEXT: TraceContext = {
  traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
};

/** An LlmPort that always fails L1 generation with a repairable (INVALID_OUTPUT) error, forcing the
 * deterministic-fallback path so observer.onError fires with phase "fallback" (mirrors correlation-id.test.ts). */
const ALWAYS_INVALID_LLM: LlmPort = {
  provider: "always-invalid",
  modelId: "always-invalid-model",
  async generateObject() {
    throw new LlmError("INVALID_OUTPUT", "always-invalid: no valid object");
  },
  async generateText() {
    throw new Error("always-invalid: generateText not supported");
  },
};

describe("ComposeOptions.traceContext", () => {
  it("is absent from the trace and every onError context when the caller passes none (byte-identical to before)", async () => {
    const errors: ComposeErrorContext[] = [];
    const ctx: ComposeContext = {
      catalog,
      semantic: makeSemantic(),
      storage: makeStorage(),
      llm: ALWAYS_INVALID_LLM,
      policy: { allowL2: false },
      observer: { onError: (errCtx) => void errors.push(errCtx) },
    };
    const result = await compose(GUI_INPUT, ctx);
    expect(result.trace.traceContext).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) expect(e.traceContext).toBeUndefined();
  });

  it("is carried through to the delivered trace on a normal (successful) compose", async () => {
    const ctx: ComposeContext = {
      catalog,
      semantic: makeSemantic(),
      storage: makeStorage(),
      llm: new FakeLlm({ objects: [goodRawDraft()] }),
      policy: {},
    };
    const result = await compose(GUI_INPUT, ctx, { traceContext: SAMPLE_TRACE_CONTEXT });
    expect(result.trace.traceContext).toEqual(SAMPLE_TRACE_CONTEXT);
  });

  it("is carried through to the trace on a cache hit", async () => {
    const storage = makeStorage();
    const ctx: ComposeContext = {
      catalog,
      semantic: makeSemantic(),
      storage,
      llm: new FakeLlm({ objects: [goodRawDraft()] }),
      policy: {},
    };
    await compose(GUI_INPUT, ctx, { traceContext: SAMPLE_TRACE_CONTEXT });
    const second = await compose(
      GUI_INPUT,
      { ...ctx, llm: new FakeLlm({ objects: [goodRawDraft()] }) },
      { traceContext: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" } },
    );
    expect(second.trace.cache).toBe("hit");
    expect(second.trace.traceContext).toEqual({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    });
  });

  it("is threaded into every observer.onError call on a fallback (generation failure), alongside correlationId", async () => {
    const errors: ComposeErrorContext[] = [];
    const ctx: ComposeContext = {
      catalog,
      semantic: makeSemantic(),
      storage: makeStorage(),
      llm: ALWAYS_INVALID_LLM,
      policy: { allowL2: false },
      observer: { onError: (errCtx) => void errors.push(errCtx) },
    };
    await compose(GUI_INPUT, ctx, { correlationId: "req-1", traceContext: SAMPLE_TRACE_CONTEXT });
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) {
      expect(e.correlationId).toBe("req-1");
      expect(e.traceContext).toEqual(SAMPLE_TRACE_CONTEXT);
    }
  });

  it("carries an optional tracestate through unchanged", async () => {
    const ctx: ComposeContext = {
      catalog,
      semantic: makeSemantic(),
      storage: makeStorage(),
      llm: new FakeLlm({ objects: [goodRawDraft()] }),
      policy: {},
    };
    const traceContext: TraceContext = { ...SAMPLE_TRACE_CONTEXT, tracestate: "vendor=value" };
    const result = await compose(GUI_INPUT, ctx, { traceContext });
    expect(result.trace.traceContext).toEqual(traceContext);
  });
});

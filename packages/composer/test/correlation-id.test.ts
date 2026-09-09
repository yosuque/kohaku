import type { LlmPort } from "@kohaku-ui/llm";
import { LlmError } from "@kohaku-ui/llm";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { GuiAction } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type ComposeContext, type ComposeErrorContext, compose, composeStream } from "../src/index.js";
import { catalog, goodRawDraft, makeSemantic, makeStorage } from "./helpers.js";

const GUI_INPUT: GuiAction = {
  kind: "gui",
  action: "facet.change",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
};

/** An LlmPort that always fails L1 generation with a repairable (INVALID_OUTPUT) error, forcing the
 * deterministic-fallback path so observer.onError fires with phase "fallback". */
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

describe("ComposeOptions.correlationId", () => {
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
    expect(result.trace.correlationId).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) expect(e.correlationId).toBeUndefined();
  });

  it("is carried through to the delivered trace on a normal (successful) compose", async () => {
    const ctx: ComposeContext = {
      catalog,
      semantic: makeSemantic(),
      storage: makeStorage(),
      llm: new FakeLlm({ objects: [goodRawDraft()] }),
      policy: {},
    };
    const result = await compose(GUI_INPUT, ctx, { correlationId: "req-abc" });
    expect(result.trace.correlationId).toBe("req-abc");
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
    await compose(GUI_INPUT, ctx, { correlationId: "first" });
    const second = await compose(
      GUI_INPUT,
      { ...ctx, llm: new FakeLlm({ objects: [goodRawDraft()] }) },
      {
        correlationId: "second-req",
      },
    );
    expect(second.trace.cache).toBe("hit");
    expect(second.trace.correlationId).toBe("second-req");
  });

  it("is threaded into every observer.onError call on a fallback (generation failure)", async () => {
    const errors: ComposeErrorContext[] = [];
    const ctx: ComposeContext = {
      catalog,
      semantic: makeSemantic(),
      storage: makeStorage(),
      llm: ALWAYS_INVALID_LLM,
      policy: { allowL2: false },
      observer: { onError: (errCtx) => void errors.push(errCtx) },
    };
    const result = await compose(GUI_INPUT, ctx, { correlationId: "req-fallback" });
    expect(result.trace.correlationId).toBe("req-fallback");
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) expect(e.correlationId).toBe("req-fallback");
    expect(errors.some((e) => e.phase === "fallback")).toBe(true);
  });

  it("is threaded into observer.onError on a hard failure (normalization throws)", async () => {
    const errors: ComposeErrorContext[] = [];
    const ctx: ComposeContext = {
      catalog,
      semantic: {
        ...makeSemantic(),
        async normalize() {
          throw new Error("boom");
        },
      },
      storage: makeStorage(),
      llm: new FakeLlm({ objects: [goodRawDraft()] }),
      policy: {},
      observer: { onError: (errCtx) => void errors.push(errCtx) },
    };
    await expect(
      compose({ kind: "nl", text: "anything" }, ctx, { correlationId: "req-hard" }),
    ).rejects.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.phase).toBe("hard");
    expect(errors[0]!.correlationId).toBe("req-hard");
  });

  it("is carried through composeStream's final trace too", async () => {
    const ctx: ComposeContext = {
      catalog,
      semantic: makeSemantic(),
      storage: makeStorage(),
      llm: new FakeLlm({ objects: [goodRawDraft()] }),
      policy: {},
    };
    let correlationId: string | undefined;
    for await (const ev of composeStream(GUI_INPUT, ctx, { correlationId: "stream-req" })) {
      if (ev.kind === "done") correlationId = ev.result.trace.correlationId;
    }
    expect(correlationId).toBe("stream-req");
  });
});

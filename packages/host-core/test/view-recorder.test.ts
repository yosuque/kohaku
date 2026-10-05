import type { ComposeTrace } from "@kohaku-ui/composer";
import type { UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import {
  recordComposedAndFallback,
  recordComposedResult,
  recordViewFallback,
  type ViewRecorder,
} from "../src/view-recorder.js";

const SPEC: UISpec = {
  kohaku: "0.1",
  intent: { canonical: "sales.trend", params: {}, hash: "sha256:" + "0".repeat(64) },
  dataVersion: "v1",
  components: [{ id: "root", type: "layout.stack", props: {}, children: [] }],
  events: [],
  provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
};

const FALLBACK_SPEC: UISpec = {
  ...SPEC,
  provenance: { ...SPEC.provenance, fallback: { from: "L1", reason: "generation failed" } },
};

type FallbackArgs = Parameters<NonNullable<ViewRecorder["fallback"]>>[0];

function traceOf(fields: Partial<ComposeTrace> = {}): ComposeTrace {
  return {
    input: { kind: "intent" },
    intent: SPEC.intent,
    refs: [],
    dataVersion: "v1",
    cacheKey: "k1",
    cacheKeyParts: { intentHash: SPEC.intent.hash, dataVersion: "v1" },
    cache: "miss",
    tier: "L0",
    attempts: [],
    durationMs: 1,
    ...fields,
  };
}

describe("recordComposedResult", () => {
  it("does not call record when the trace is cancelled", async () => {
    const record = vi.fn(async () => {});
    const onError = vi.fn();
    await recordComposedResult({ spec: SPEC, trace: traceOf({ cancelled: true }) }, record, onError);
    expect(record).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("calls record exactly once on the happy path", async () => {
    const record = vi.fn(async () => {});
    const onError = vi.fn();
    await recordComposedResult({ spec: SPEC, trace: traceOf() }, record, onError);
    expect(record).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("calls onError once and resolves (does not throw) when record rejects", async () => {
    const boom = new Error("record failed");
    const record = vi.fn(async () => {
      throw boom;
    });
    const onError = vi.fn();
    await expect(
      recordComposedResult({ spec: SPEC, trace: traceOf() }, record, onError),
    ).resolves.toBeUndefined();
    expect(record).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);
  });
});

describe("recordViewFallback", () => {
  it("does nothing when the spec has no fallback", async () => {
    const fallback = vi.fn(async (_args: FallbackArgs) => {});
    const recorder: ViewRecorder = { composed: vi.fn(), interacted: vi.fn(), fallback };
    await recordViewFallback(recorder, SPEC, { surface: "web" });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("forwards correlationId to the recorder when given", async () => {
    const fallback = vi.fn(async (_args: FallbackArgs) => {});
    const recorder: ViewRecorder = { composed: vi.fn(), interacted: vi.fn(), fallback };
    await recordViewFallback(recorder, FALLBACK_SPEC, { surface: "web", correlationId: "req-1" });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback.mock.calls[0]![0]).toMatchObject({ correlationId: "req-1" });
  });

  it("omits correlationId from the recorder call when not given (byte-identical to before)", async () => {
    const fallback = vi.fn(async (_args: FallbackArgs) => {});
    const recorder: ViewRecorder = { composed: vi.fn(), interacted: vi.fn(), fallback };
    await recordViewFallback(recorder, FALLBACK_SPEC, { surface: "web" });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect("correlationId" in fallback.mock.calls[0]![0]).toBe(false);
  });
});

describe("recordComposedAndFallback", () => {
  type ComposedArgs = Parameters<ViewRecorder["composed"]>[0];

  function recording(): {
    recorder: ViewRecorder;
    calls: string[];
    composed: ComposedArgs[];
    fallback: FallbackArgs[];
  } {
    const calls: string[] = [];
    const composed: ComposedArgs[] = [];
    const fallback: FallbackArgs[] = [];
    return {
      calls,
      composed,
      fallback,
      recorder: {
        async composed(args) {
          calls.push("composed");
          composed.push(args);
        },
        async fallback(args) {
          calls.push("fallback");
          fallback.push(args);
        },
        async interacted() {},
      },
    };
  }

  it("does nothing when no recorder is wired", async () => {
    await expect(
      recordComposedAndFallback(undefined, { spec: FALLBACK_SPEC, trace: traceOf() }, { surface: "web" }),
    ).resolves.toBeUndefined();
  });

  it("records composed only for a spec without a fallback, with the REST-shaped keys in order", async () => {
    const { recorder, composed, fallback } = recording();
    const trace = traceOf({ correlationId: "req-1" });
    await recordComposedAndFallback(
      recorder,
      { spec: SPEC, trace },
      { surface: "web", specHash: "sha256:abc", sessionId: "s-1", tenant: "acme" },
    );
    expect(composed).toHaveLength(1);
    expect(Object.keys(composed[0]!)).toEqual([
      "spec",
      "trace",
      "surface",
      "specHash",
      "sessionId",
      "tenant",
    ]);
    expect(composed[0]).toEqual({
      spec: SPEC,
      trace,
      surface: "web",
      specHash: "sha256:abc",
      sessionId: "s-1",
      tenant: "acme",
    });
    expect(fallback).toEqual([]);
  });

  it("records composed then fallback, the fallback carrying specHash, session meta and the trace's correlationId", async () => {
    const { recorder, calls, composed, fallback } = recording();
    const trace = traceOf({ correlationId: "req-2" });
    await recordComposedAndFallback(
      recorder,
      { spec: FALLBACK_SPEC, trace },
      { surface: "web", specHash: "sha256:abc", sessionId: "s-1", tenant: "acme" },
    );
    expect(calls).toEqual(["composed", "fallback"]);
    expect(composed).toHaveLength(1);
    expect(fallback).toHaveLength(1);
    expect(Object.keys(fallback[0]!)).toEqual([
      "spec",
      "reason",
      "kind",
      "surface",
      "specHash",
      "sessionId",
      "tenant",
      "correlationId",
    ]);
    expect(fallback[0]).toEqual({
      spec: FALLBACK_SPEC,
      reason: "generation failed",
      kind: "generation",
      surface: "web",
      specHash: "sha256:abc",
      sessionId: "s-1",
      tenant: "acme",
      correlationId: "req-2",
    });
  });

  it("omits every absent optional key (MCP shape: surface only, no correlationId on the trace)", async () => {
    const { recorder, composed, fallback } = recording();
    await recordComposedAndFallback(
      recorder,
      { spec: FALLBACK_SPEC, trace: traceOf() },
      { surface: "mcp-app" },
    );
    expect(Object.keys(composed[0]!)).toEqual(["spec", "trace", "surface"]);
    expect(Object.keys(fallback[0]!)).toEqual(["spec", "reason", "kind", "surface"]);
  });

  it("does not record the fallback when composed rejects (the rejection propagates to the caller)", async () => {
    const boom = new Error("composed failed");
    const fallbackSpy = vi.fn(async () => {});
    const recorder: ViewRecorder = {
      async composed() {
        throw boom;
      },
      fallback: fallbackSpy,
      async interacted() {},
    };
    await expect(
      recordComposedAndFallback(recorder, { spec: FALLBACK_SPEC, trace: traceOf() }, { surface: "web" }),
    ).rejects.toBe(boom);
    expect(fallbackSpy).not.toHaveBeenCalled();
  });
});

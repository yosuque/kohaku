import type { ComposeTrace } from "@kohaku-ui/composer";
import type { UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import { recordComposedResult, recordViewFallback, type ViewRecorder } from "../src/view-recorder.js";

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

  it("forwards correlationId to the recorder when given (U2)", async () => {
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

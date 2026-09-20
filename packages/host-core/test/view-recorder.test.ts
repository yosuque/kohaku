import type { ComposeTrace } from "@kohaku-ui/composer";
import type { UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import { recordComposedResult } from "../src/view-recorder.js";

const SPEC: UISpec = {
  kohaku: "0.1",
  intent: { canonical: "sales.trend", params: {}, hash: "sha256:" + "0".repeat(64) },
  dataVersion: "v1",
  components: [{ id: "root", type: "layout.stack", props: {}, children: [] }],
  events: [],
  provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
};

function traceOf(fields: Partial<ComposeTrace> = {}): ComposeTrace {
  return {
    input: { kind: "intent" },
    intent: SPEC.intent,
    refs: [],
    dataVersion: "v1",
    cacheKey: "k1",
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

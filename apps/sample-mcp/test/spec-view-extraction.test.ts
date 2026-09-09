/**
 * Pure-logic checks for the bridge's Spec extraction / self-recovery decisions (renderer/host-integration.ts).
 * Pins the behavior of extractSpecView (the shared core of tool-result / self-recovery / kohaku_event),
 * readInitialData (the tool-result's _meta co-embedded initial data), and recoveryBlockReason without a DOM — the characterization
 * net for decomposing main.tsx's bootBridge.
 */
import type { TabularData } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_META_KEY,
  extractSpecView,
  INITIAL_DATA_META_KEY,
  readInitialData,
  recoveryBlockReason,
} from "../renderer/host-integration.js";

/** Minimal valid Spec that passes parseSpec (wire form). intent.hash must be in `sha256:<hex64>` format. */
const WIRE_SPEC = {
  kohaku: "0.1",
  intent: { canonical: "sales.trend", params: {}, hash: `sha256:${"ab".repeat(32)}` },
  dataVersion: "sales@seed-1",
  components: [
    { id: "root", type: "layout.stack", props: {}, children: ["t"] },
    { id: "t", type: "text.heading", props: { level: 2, text: "Heading" } },
  ],
  events: [],
  provenance: { tier: "L0", composedBy: "test", cache: "miss" },
};

const TABULAR: TabularData = {
  columns: [{ key: "v", label: "V", type: "number" }],
  rows: [{ v: 1 }],
  dataVersion: "v1",
};

describe("extractSpecView (spec/capability extraction from a tool result)", () => {
  it("extracts spec from structuredContent + capability + the initial data, both from _meta, as a Map", () => {
    const extracted = extractSpecView({
      structuredContent: { spec: WIRE_SPEC },
      _meta: {
        [INITIAL_DATA_META_KEY]: { "query://sales/trend": TABULAR },
        [CAPABILITY_META_KEY]: "cap-1",
      },
    });
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    expect(extracted.view.spec.intent.canonical).toBe("sales.trend");
    expect(extracted.view.capability).toBe("cap-1");
    expect(extracted.view.initialData?.get("query://sales/trend")).toEqual(TABULAR);
  });

  it("omits initialData when _meta carries none (the key stays absent, not an empty Map)", () => {
    const extracted = extractSpecView({
      structuredContent: { spec: WIRE_SPEC },
      _meta: { [CAPABILITY_META_KEY]: "cap-1" },
    });
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    expect("initialData" in extracted.view).toBe(false);
  });

  it("reports 'missing' with which half is absent (spec missing)", () => {
    const extracted = extractSpecView({ structuredContent: {}, _meta: { [CAPABILITY_META_KEY]: "cap-1" } });
    expect(extracted).toEqual({
      ok: false,
      reason: "missing",
      detail: "structuredContent has no spec / _meta has no capability (spec=no, capability=yes)",
    });
  });

  it("reports 'missing' with which half is absent (capability missing from _meta)", () => {
    const extracted = extractSpecView({ structuredContent: { spec: WIRE_SPEC } });
    expect(extracted).toEqual({
      ok: false,
      reason: "missing",
      detail: "structuredContent has no spec / _meta has no capability (spec=yes, capability=no)",
    });
  });

  it("does not fall back to a legacy structuredContent.capability (the migration is one-way)", () => {
    const extracted = extractSpecView({
      structuredContent: { spec: WIRE_SPEC, capability: "legacy-cap" },
    });
    expect(extracted.ok).toBe(false);
    if (extracted.ok) return;
    expect(extracted.reason).toBe("missing");
  });

  it("treats null / shapeless payloads as 'missing' (a stripped tool-result notification)", () => {
    expect(extractSpecView(null).ok).toBe(false);
    expect(extractSpecView({}).ok).toBe(false);
    expect(extractSpecView({ content: [{ type: "text", text: "fallback" }] }).ok).toBe(false);
  });

  it("reports 'parse-error' with the parseSpec message for a malformed spec", () => {
    const extracted = extractSpecView({
      structuredContent: { spec: { kohaku: "0.1" } },
      _meta: { [CAPABILITY_META_KEY]: "cap-1" },
    });
    expect(extracted.ok).toBe(false);
    if (extracted.ok) return;
    expect(extracted.reason).toBe("parse-error");
    expect(extracted.detail.length).toBeGreaterThan(0);
  });
});

describe("readInitialData (_meta co-embedded initial data)", () => {
  it("returns undefined when _meta is absent or carries no initial data", () => {
    expect(readInitialData({})).toBeUndefined();
    expect(readInitialData({ _meta: {} })).toBeUndefined();
  });

  it("converts the embedded record into a Map keyed by the effective ref", () => {
    const map = readInitialData({ _meta: { [INITIAL_DATA_META_KEY]: { "query://a": TABULAR } } });
    expect(map?.size).toBe(1);
    expect(map?.get("query://a")).toEqual(TABULAR);
  });
});

describe("recoveryBlockReason (self-recovery tool-name decision)", () => {
  it("blocks when toolInfo is unavailable", () => {
    expect(recoveryBlockReason(undefined)).toBe("no toolInfo");
  });

  it("blocks snapshot-generation tools (they return HTML, not a Spec)", () => {
    expect(recoveryBlockReason("kohaku_render_snapshot")).toBe(
      "a snapshot-generation tool does not return a Spec",
    );
  });

  it("allows compose-family tools (cached — re-calling returns the same Spec)", () => {
    expect(recoveryBlockReason("kohaku_compose")).toBeNull();
    expect(recoveryBlockReason("sales_trend")).toBeNull();
  });
});

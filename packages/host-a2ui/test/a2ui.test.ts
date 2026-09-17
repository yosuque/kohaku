import type { SpecPatch, TabularData, UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import type {
  A2uiCallAgentFunction,
  A2uiCreateSurfaceV1,
  A2uiRendererFunctionResponse,
  A2uiUpdateComponents,
} from "../src/index.js";
import {
  A2UI_V1_VERSION,
  A2UI_VERSION,
  escapeJsonPointerToken,
  fromA2uiEvent,
  patchToA2ui,
  serializeA2uiLines,
  toA2ui,
} from "../src/index.js";

const REF = "query://sales/summary?fy=2026&groupBy=region&q=3";
const HASH = `sha256:${"a".repeat(64)}`;
const SURFACE = `kohaku-${"a".repeat(64)}`;

/** A representative UISpec equivalent to quarterly-sales (heading + chart + table + rowClick event). */
function quarterlySalesSpec(): UISpec {
  return {
    kohaku: "0.2",
    intent: {
      canonical: "sales.quarterly_summary",
      params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
      hash: HASH,
    },
    dataVersion: "sales@seed-1",
    refVersions: { [REF]: "sales@seed-1" },
    components: [
      {
        id: "root",
        type: "layout.stack",
        props: { direction: "vertical", gap: "md" },
        children: ["t", "c", "g"],
      },
      { id: "t", type: "text.heading", props: { level: 2, text: "FY2026 Q3 Sales (by region)" } },
      {
        id: "c",
        type: "presentChart",
        props: { kind: "bar", x: "region", y: "revenue" },
        data: { $ref: REF },
      },
      { id: "g", type: "presentSpreadsheet", props: { editable: false }, data: { $ref: REF } },
    ],
    events: [{ on: "g.rowClick", emit: "intent.patch", payload: { drilldown: "$row.region" } }],
    provenance: { tier: "L0", composedBy: "test", cache: "miss" },
  };
}

/** UISpec of root(Column) -> heading + button (for verifying Button / event mapping). */
function buttonSpec(): UISpec {
  return {
    kohaku: "0.2",
    intent: { canonical: "sales.action", params: {}, hash: HASH },
    dataVersion: "sales@seed-1",
    components: [
      {
        id: "root",
        type: "layout.stack",
        props: { direction: "horizontal", justify: "center" },
        children: ["h", "btn"],
      },
      { id: "h", type: "text.heading", props: { level: 3, text: "Actions" } },
      { id: "btn", type: "action.button", props: { label: "Recompute", variant: "primary" } },
    ],
    events: [{ on: "btn.press", emit: "action.invoke", payload: {} }],
    provenance: { tier: "L0", composedBy: "test", cache: "miss" },
  };
}

/** Helper that extracts the updateComponents message body. */
function updateComponentsOf(env: { updateComponents: A2uiUpdateComponents }): A2uiUpdateComponents {
  return env.updateComponents;
}

describe("toA2ui: UISpec → A2UI v0.9.1 messages", () => {
  it("createSurface → updateComponents in 2 messages, each envelope has version + a single key", async () => {
    const { messages } = await toA2ui(quarterlySalesSpec());
    expect(messages).toHaveLength(2);
    // Each envelope has only a version and a single message key
    for (const m of messages) {
      expect(m.version).toBe(A2UI_VERSION);
      const keys = Object.keys(m).filter((k) => k !== "version");
      expect(keys).toHaveLength(1);
    }
    expect(messages[0]).toHaveProperty("createSurface");
    expect(messages[1]).toHaveProperty("updateComponents");
  });

  it("createSurface has surfaceId (derived from intent.hash) + catalogId", async () => {
    const { messages } = await toA2ui(quarterlySalesSpec());
    const create = (messages[0] as { createSurface: { surfaceId: string; catalogId: string } }).createSurface;
    expect(create.surfaceId).toBe(SURFACE);
    expect(create.catalogId).toMatch(/catalog|catalogs|\.json/);
  });

  it("updateComponents maps flat-form components (id / component / children) isomorphically", async () => {
    const { messages } = await toA2ui(quarterlySalesSpec());
    const uc = updateComponentsOf(messages[1] as { updateComponents: A2uiUpdateComponents });
    expect(uc.surfaceId).toBe(SURFACE);
    expect(uc.components.map((c) => c.id)).toEqual(["root", "t", "c", "g"]);
    // Preserve children references (adjacency list)
    expect(uc.components[0]!.children).toEqual(["t", "c", "g"]);
    // Flat form: component is a direct value, not a type wrapper (component:{Text:{}})
    expect(uc.components[1]!.component).toBe("Text");
  });

  it("core mapping table: layout.stack→Column / text.heading→Text, unsupported goes to component verbatim", async () => {
    const { messages } = await toA2ui(quarterlySalesSpec());
    const uc = updateComponentsOf(messages[1] as { updateComponents: A2uiUpdateComponents });
    const byId = new Map(uc.components.map((c) => [c.id, c]));
    expect(byId.get("root")!.component).toBe("Column"); // direction vertical
    expect(byId.get("t")!.component).toBe("Text");
    expect(byId.get("t")!["variant"]).toBe("h2"); // level 2 → variant h2
    // An unsupported type keeps the kohaku type verbatim in component, with props placed directly
    expect(byId.get("c")!.component).toBe("presentChart");
    expect(byId.get("c")!["kind"]).toBe("bar");
    expect(byId.get("g")!.component).toBe("presentSpreadsheet");
  });

  it("horizontal layout.stack maps to Row + justify", async () => {
    const { messages } = await toA2ui(buttonSpec());
    const uc = updateComponentsOf(messages[1] as { updateComponents: A2uiUpdateComponents });
    const root = uc.components.find((c) => c.id === "root")!;
    expect(root.component).toBe("Row");
    expect(root["justify"]).toBe("center");
  });

  it("action.button → Button (synthesizes a label Text as child) + variant mapping", async () => {
    const { messages } = await toA2ui(buttonSpec());
    const uc = updateComponentsOf(messages[1] as { updateComponents: A2uiUpdateComponents });
    const btn = uc.components.find((c) => c.id === "btn")!;
    expect(btn.component).toBe("Button");
    expect(btn.child).toBe("btn__label");
    expect(btn["variant"]).toBe("primary");
    // A synthesized label Text exists, and label maps into its text
    const label = uc.components.find((c) => c.id === "btn__label")!;
    expect(label.component).toBe("Text");
    expect(label["text"]).toBe("Recompute");
  });

  it("event mapping: moves EventBinding to the source component's action.event", async () => {
    const { messages } = await toA2ui(quarterlySalesSpec());
    const uc = updateComponentsOf(messages[1] as { updateComponents: A2uiUpdateComponents });
    const g = uc.components.find((c) => c.id === "g")!;
    expect(g.action).toEqual({ event: { name: "g.rowClick", context: {} } });
    // A component that is not the firing source gets no action
    expect(uc.components.find((c) => c.id === "t")!.action).toBeUndefined();
  });

  it("Button's action overrides the default press with the EventBinding", async () => {
    const { messages } = await toA2ui(buttonSpec());
    const uc = updateComponentsOf(messages[1] as { updateComponents: A2uiUpdateComponents });
    const btn = uc.components.find((c) => c.id === "btn")!;
    expect(btn.action).toEqual({ event: { name: "btn.press", context: {} } });
  });

  it("by default no data is included (A2UI messages are strict and contain no x-kohaku-*)", async () => {
    const { messages } = await toA2ui(quarterlySalesSpec());
    expect(messages.some((m) => "updateDataModel" in m)).toBe(false);
    const uc = updateComponentsOf(messages[1] as { updateComponents: A2uiUpdateComponents });
    for (const c of uc.components) {
      expect(Object.keys(c).some((k) => k.startsWith("x-kohaku"))).toBe(false);
    }
  });

  it("updateDataModel only when resolveData is provided (path is /refs/<RFC6901-escaped ref>, duplicate ref once)", async () => {
    const data: TabularData = {
      columns: [
        { key: "region", type: "string" },
        { key: "revenue", type: "number" },
      ],
      rows: [{ region: "west", revenue: 100 }],
      dataVersion: "sales@seed-1",
    };
    const calls: string[] = [];
    const { messages } = await toA2ui(quarterlySalesSpec(), {
      resolveData: async (ref) => {
        calls.push(ref);
        return data;
      },
    });
    // c and g reference the same REF -> resolved once, and a single updateDataModel
    expect(calls).toEqual([REF]);
    const dmu = messages.filter((m) => "updateDataModel" in m) as {
      updateDataModel: { surfaceId: string; path?: string; value?: unknown };
    }[];
    expect(dmu).toHaveLength(1);
    expect(dmu[0]!.updateDataModel.surfaceId).toBe(SURFACE);
    expect(dmu[0]!.updateDataModel.path).toBe(`/refs/${escapeJsonPointerToken(REF)}`);
    // Escaping is applied (/ -> ~1)
    expect(dmu[0]!.updateDataModel.path).not.toContain("query://");
    expect((dmu[0]!.updateDataModel.value as TabularData).rows).toEqual(data.rows);
  });

  it("resolves multiple distinct refs concurrently, but pushes updateDataModel messages in uniqueRefs (component-scan) order regardless of resolution order", async () => {
    const REF_A = "query://sales/summary?fy=2026&groupBy=region&q=3";
    const REF_B = "query://sales/kpi?fy=2026";
    const spec: UISpec = {
      kohaku: "0.2",
      intent: { canonical: "sales.two_refs", params: {}, hash: HASH },
      dataVersion: "multi:seed-1",
      refVersions: { [REF_A]: "sales@seed-1", [REF_B]: "kpi@seed-1" },
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["a", "b"] },
        { id: "a", type: "presentSpreadsheet", props: { editable: false }, data: { $ref: REF_A } },
        { id: "b", type: "presentChart", props: { kind: "bar", x: "x", y: "y" }, data: { $ref: REF_B } },
      ],
      events: [],
      provenance: { tier: "L0", composedBy: "test", cache: "miss" },
    };

    function deferred(): { promise: Promise<TabularData>; resolve: (v: TabularData) => void } {
      let resolve!: (v: TabularData) => void;
      const promise = new Promise<TabularData>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    const startedOrder: string[] = [];
    const deferredByRef = new Map<
      string,
      { promise: Promise<TabularData>; resolve: (v: TabularData) => void }
    >();
    const resultPromise = toA2ui(spec, {
      resolveData: (ref) => {
        startedOrder.push(ref);
        const d = deferred();
        deferredByRef.set(ref, d);
        return d.promise;
      },
    });

    // A microtask tick is enough for Promise.all(refs.map(resolveData)) to invoke resolveData for every
    // ref up front (synchronously, before awaiting any of them) — a sequential for-await loop would only
    // have called it for REF_A at this point, since REF_A's promise has not resolved yet.
    await Promise.resolve();
    expect(startedOrder).toEqual([REF_A, REF_B]);

    // Resolve out of scan order (B before A): the final message order must still follow uniqueRefs
    // (component-scan) order, not resolution order.
    deferredByRef.get(REF_B)!.resolve({ columns: [], rows: [], dataVersion: "b" });
    deferredByRef.get(REF_A)!.resolve({ columns: [], rows: [], dataVersion: "a" });

    const { messages } = await resultPromise;
    const dmu = messages.filter((m) => "updateDataModel" in m) as {
      updateDataModel: { path?: string; value?: unknown };
    }[];
    expect(dmu).toHaveLength(2);
    expect(dmu[0]!.updateDataModel.path).toBe(`/refs/${escapeJsonPointerToken(REF_A)}`);
    expect((dmu[0]!.updateDataModel.value as TabularData).dataVersion).toBe("a");
    expect(dmu[1]!.updateDataModel.path).toBe(`/refs/${escapeJsonPointerToken(REF_B)}`);
    expect((dmu[1]!.updateDataModel.value as TabularData).dataVersion).toBe("b");
  });
});

describe("toA2ui: sidecar preservation of kohaku-specific information", () => {
  it("preserves intent / provenance / dataVersion / refVersions / events", async () => {
    const spec = quarterlySalesSpec();
    const { sidecar } = await toA2ui(spec);
    expect(sidecar.intent).toEqual(spec.intent);
    expect(sidecar.provenance).toEqual(spec.provenance);
    expect(sidecar.dataVersion).toBe("sales@seed-1");
    expect(sidecar.refVersions).toEqual({ [REF]: "sales@seed-1" });
    expect(sidecar.events).toEqual(spec.events);
  });

  it("preserves the original ComponentNode (type / data.$ref / props) losslessly per id", async () => {
    const spec = quarterlySalesSpec();
    const { sidecar } = await toA2ui(spec);
    expect(sidecar.components["root"]!.type).toBe("layout.stack");
    expect(sidecar.components["c"]!.type).toBe("presentChart");
    expect(sidecar.components["c"]!.data?.$ref).toBe(REF);
    // props are preserved as-is (including info lowered to A2UI such as gap)
    expect(sidecar.components["root"]!.props["gap"]).toBe("md");
  });
});

describe("patchToA2ui: SpecPatch → incremental update (v0.9.1)", () => {
  it("maps upsert to updateComponents.components (id-match upsert), baseIntentHash goes to the sidecar", () => {
    const patch: SpecPatch = {
      baseIntentHash: HASH,
      upsert: [{ id: "t", type: "text.heading", props: { level: 2, text: "New title" } }],
      dataVersion: "sales@seed-2",
    };
    const { messages, sidecar } = patchToA2ui(patch);
    expect(messages).toHaveLength(1);
    const uc = updateComponentsOf(messages[0] as { updateComponents: A2uiUpdateComponents });
    expect(uc.surfaceId).toBe(SURFACE);
    expect(uc.components.map((c) => c.id)).toEqual(["t"]);
    expect(uc.components[0]!.component).toBe("Text");
    expect(sidecar.baseIntentHash).toBe(HASH);
    expect(sidecar.dataVersion).toBe("sales@seed-2");
  });

  it("a patch with remove re-sends all components after application when appliedSpec is present", () => {
    const applied = quarterlySalesSpec();
    const patch: SpecPatch = { baseIntentHash: HASH, remove: ["old"] };
    const { messages } = patchToA2ui(patch, applied);
    const uc = updateComponentsOf(messages[0] as { updateComponents: A2uiUpdateComponents });
    // Full re-send: all ids of the spec after application
    expect(uc.components.map((c) => c.id)).toEqual(["root", "t", "c", "g"]);
  });

  it("a patch with remove errors when appliedSpec is absent (A2UI has no delete message)", () => {
    const patch: SpecPatch = { baseIntentHash: HASH, remove: ["old"] };
    expect(() => patchToA2ui(patch)).toThrow(/full re-send|appliedSpec/);
  });

  it("components is an empty array when there is no upsert", () => {
    const { messages } = patchToA2ui({ baseIntentHash: HASH });
    const uc = updateComponentsOf(messages[0] as { updateComponents: A2uiUpdateComponents });
    expect(uc.components).toEqual([]);
  });
});

describe("fromA2uiEvent: A2UI client action → GuiAction (v0.9.1)", () => {
  it("maps action.name to action and context to params", () => {
    const action = fromA2uiEvent({
      name: "g.rowClick",
      surfaceId: SURFACE,
      sourceComponentId: "g",
      timestamp: "2026-07-18T00:00:00Z",
      context: { region: "west" },
    });
    expect(action).toEqual({ kind: "gui", action: "g.rowClick", params: { region: "west" } });
  });

  it("toA2ui event mapping → client action → fromA2uiEvent round-trip", async () => {
    const { messages } = await toA2ui(quarterlySalesSpec());
    const uc = updateComponentsOf(messages[1] as { updateComponents: A2uiUpdateComponents });
    const g = uc.components.find((c) => c.id === "g")!;
    // The client action returns the server-declared event.name as-is
    const name = (g.action as { event: { name: string } }).event.name;
    const roundTrip = fromA2uiEvent({
      name,
      surfaceId: uc.surfaceId,
      sourceComponentId: "g",
      timestamp: "2026-07-18T00:00:00Z",
      context: { region: "west" },
    });
    expect(roundTrip).toEqual({ kind: "gui", action: "g.rowClick", params: { region: "west" } });
  });
});

describe("serializeA2uiLines: JSONL serialization", () => {
  it("one message per line (compact JSON), each line a valid A2UI envelope", async () => {
    const { messages } = await toA2ui(quarterlySalesSpec());
    const jsonl = serializeA2uiLines(messages);
    const lines = jsonl.split("\n");
    expect(lines).toHaveLength(messages.length);
    // Compact JSON with no spaces per line (verified by parseability, not by assuming no spaces)
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed[0]).toHaveProperty("createSurface");
    expect(parsed[0]!["version"]).toBe(A2UI_VERSION);
    expect(parsed[1]).toHaveProperty("updateComponents");
  });

  it("empty array yields empty string", () => {
    expect(serializeA2uiLines([])).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// target: "v1.0" (opt-in A2UI v1.0 RC). Default output (target omitted or "v0.9.1") MUST stay
// byte-identical to the pre-v1.0 shape — locked by an exact JSON.stringify golden below.
// ─────────────────────────────────────────────────────────────────────────────

describe("toA2ui / patchToA2ui: target v0.9.1 (default) output is byte-identical to pre-v1.0 output (golden)", () => {
  it("toA2ui default output matches the exact pre-v1.0 JSON byte-for-byte", async () => {
    const { messages } = await toA2ui(quarterlySalesSpec());
    const golden =
      `[{"version":"v0.9.1","createSurface":{"surfaceId":"${SURFACE}",` +
      `"catalogId":"https://kohaku-ui.dev/a2ui/catalogs/core.json"}},` +
      `{"version":"v0.9.1","updateComponents":{"surfaceId":"${SURFACE}","components":[` +
      `{"id":"root","component":"Column","children":["t","c","g"]},` +
      `{"id":"t","component":"Text","text":"FY2026 Q3 Sales (by region)","variant":"h2"},` +
      `{"id":"c","component":"presentChart","kind":"bar","x":"region","y":"revenue"},` +
      `{"id":"g","component":"presentSpreadsheet","editable":false,"action":{"event":{"name":"g.rowClick","context":{}}}}` +
      `]}}]`;
    expect(JSON.stringify(messages)).toBe(golden);
  });

  it("toA2ui default output is unaffected by opts.target being explicitly 'v0.9.1'", async () => {
    const a = await toA2ui(quarterlySalesSpec());
    const b = await toA2ui(quarterlySalesSpec(), { target: "v0.9.1" });
    expect(JSON.stringify(b.messages)).toBe(JSON.stringify(a.messages));
  });

  it("patchToA2ui default output matches the exact pre-v1.0 JSON byte-for-byte", () => {
    const patch: SpecPatch = {
      baseIntentHash: HASH,
      upsert: [{ id: "t", type: "text.heading", props: { level: 2, text: "New title" } }],
      dataVersion: "sales@seed-2",
    };
    const { messages } = patchToA2ui(patch);
    const golden =
      `[{"version":"v0.9.1","updateComponents":{"surfaceId":"${SURFACE}","components":[` +
      `{"id":"t","component":"Text","text":"New title","variant":"h2"}]}}]`;
    expect(JSON.stringify(messages)).toBe(golden);
  });
});

describe("toA2ui: target 'v1.0' (A2UI v1.0 RC, opt-in)", () => {
  it("emits a single createSurface message with version v1.0 (no separate updateComponents)", async () => {
    const { messages } = await toA2ui(quarterlySalesSpec(), { target: "v1.0" });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.version).toBe(A2UI_V1_VERSION);
    expect(messages[0]!.version).toBe("v1.0");
    expect("createSurface" in messages[0]!).toBe(true);
    const keys = Object.keys(messages[0]!).filter((k) => k !== "version");
    expect(keys).toEqual(["createSurface"]);
  });

  it("bundles the full component tree into createSurface.components (same components as the v0.9.1 updateComponents)", async () => {
    const v1 = await toA2ui(quarterlySalesSpec(), { target: "v1.0" });
    const v091 = await toA2ui(quarterlySalesSpec());
    const createSurface = (v1.messages[0] as { createSurface: A2uiCreateSurfaceV1 }).createSurface;
    const v091Components = (v091.messages[1] as { updateComponents: A2uiUpdateComponents }).updateComponents
      .components;
    expect(createSurface.surfaceId).toBe(SURFACE);
    expect(createSurface.catalogId).toMatch(/catalog|catalogs|\.json/);
    expect(createSurface.components).toEqual(v091Components);
  });

  it("does not emit a theme field (removed in the v1.0 RC per its 'Decoupled Branding' change)", async () => {
    const { messages } = await toA2ui(quarterlySalesSpec(), { target: "v1.0" });
    const createSurface = (messages[0] as { createSurface: A2uiCreateSurfaceV1 }).createSurface;
    expect(createSurface).not.toHaveProperty("theme");
  });

  it("without resolveData, createSurface has no dataModel field", async () => {
    const { messages } = await toA2ui(quarterlySalesSpec(), { target: "v1.0" });
    const createSurface = (messages[0] as { createSurface: A2uiCreateSurfaceV1 }).createSurface;
    expect(createSurface).not.toHaveProperty("dataModel");
  });

  it("with resolveData, bundles the data model into createSurface.dataModel (no separate updateDataModel message)", async () => {
    const data: TabularData = {
      columns: [
        { key: "region", type: "string" },
        { key: "revenue", type: "number" },
      ],
      rows: [{ region: "west", revenue: 100 }],
      dataVersion: "sales@seed-1",
    };
    const calls: string[] = [];
    const { messages } = await toA2ui(quarterlySalesSpec(), {
      target: "v1.0",
      resolveData: async (ref) => {
        calls.push(ref);
        return data;
      },
    });
    expect(calls).toEqual([REF]);
    // Still exactly one message (createSurface) — no updateDataModel message is emitted under v1.0
    expect(messages).toHaveLength(1);
    const createSurface = (messages[0] as { createSurface: A2uiCreateSurfaceV1 }).createSurface;
    // Object key: the raw (unescaped) ref, since this is a plain object key, not a JSON Pointer path segment.
    const dataModel = createSurface.dataModel as unknown as { refs: Record<string, TabularData> };
    expect(dataModel.refs[REF]?.rows).toEqual(data.rows);
  });
});

describe("patchToA2ui: target 'v1.0' (A2UI v1.0 RC, opt-in)", () => {
  it("emits version v1.0; updateComponents shape itself is unchanged from v0.9.1", () => {
    const patch: SpecPatch = {
      baseIntentHash: HASH,
      upsert: [{ id: "t", type: "text.heading", props: { level: 2, text: "New title" } }],
      dataVersion: "sales@seed-2",
    };
    const v1 = patchToA2ui(patch, undefined, { target: "v1.0" });
    const v091 = patchToA2ui(patch);
    expect(v1.messages[0]!.version).toBe("v1.0");
    const v1Uc = (v1.messages[0] as { updateComponents: A2uiUpdateComponents }).updateComponents;
    const v091Uc = (v091.messages[0] as { updateComponents: A2uiUpdateComponents }).updateComponents;
    expect(v1Uc).toEqual(v091Uc);
  });

  it("defaults to v0.9.1 when opts is omitted (patchToA2ui(patch, appliedSpec) 2-arg call keeps working)", () => {
    const applied = quarterlySalesSpec();
    const patch: SpecPatch = { baseIntentHash: HASH, remove: ["old"] };
    const { messages } = patchToA2ui(patch, applied);
    expect(messages[0]!.version).toBe(A2UI_VERSION);
  });
});

describe("fromA2uiEvent: v1.0 client messages with no kohaku equivalent (callAgentFunction / rendererFunctionResponse)", () => {
  it("callAgentFunction returns an explicit unsupported result (existing `action` path is unchanged)", () => {
    const callAgentFunction: A2uiCallAgentFunction = {
      surfaceId: SURFACE,
      functionCallId: "call-1",
      callFunction: { call: "lookupUser", args: {} },
    };
    const result = fromA2uiEvent({ callAgentFunction });
    expect(result.kind).toBe("unsupported");
    expect((result as { kind: "unsupported"; reason: string }).reason).toContain("callAgentFunction");
  });

  it("rendererFunctionResponse returns an explicit unsupported result", () => {
    const rendererFunctionResponse: A2uiRendererFunctionResponse = {
      functionCallId: "call-1",
      value: 42,
    };
    const result = fromA2uiEvent({ rendererFunctionResponse });
    expect(result.kind).toBe("unsupported");
    expect((result as { kind: "unsupported"; reason: string }).reason).toContain("rendererFunctionResponse");
  });

  it("the existing `action` overload still returns a plain GuiAction (not wrapped)", () => {
    const result = fromA2uiEvent({
      name: "g.rowClick",
      surfaceId: SURFACE,
      sourceComponentId: "g",
      timestamp: "2026-07-18T00:00:00Z",
      context: { region: "west" },
    });
    expect(result).toEqual({ kind: "gui", action: "g.rowClick", params: { region: "west" } });
  });
});

/**
 * Structural checks against the A2UI v1.0 RC's real JSON Schema. The schema files themselves
 * (`agent_to_renderer.json`, `common_types.json`, `renderer_to_agent.json` from
 * `a2ui-project/a2ui@main:specification/v1_0/json/`) were fetched directly from GitHub and from
 * https://a2ui.org/specification/v1.0-a2ui/ during implementation (not reconstructed from memory).
 *
 * A full ajv-based JSON Schema validation run was deliberately not wired in: `Component` in the real
 * schema resolves `catalog.json#/$defs/anyComponent` (the A2UI *basic* catalog), and this profile's
 * verbatim (non-core-mapped) component types (e.g. `presentChart`, `presentSpreadsheet`) intentionally
 * are not members of that catalog — a real `catalog.json` for kohaku's own catalog id does not exist as
 * a resolvable schema, so a strict `unevaluatedProperties:false` component-level validation would fail
 * by design and prove nothing about the *message envelope* shape this profile is responsible for.
 * Adding a JSON-Schema-validator dependency (e.g. ajv) to `host-a2ui` for this reason alone would also
 * grow an "independent leaf" package's dependency footprint for a Draft/RC profile. Instead, the
 * fetched schema's asserted facts (required/forbidden keys, `additionalProperties: false`, `oneOf`
 * single-key envelope, `minItems: 1`) are encoded directly as assertions below.
 */
describe("v1.0 RC structural checks (asserted directly from the fetched JSON Schema, no ajv dependency)", () => {
  it("createSurface (v1.0) carries only keys allowed by CreateSurfaceMessage.createSurface (additionalProperties:false)", async () => {
    const { messages } = await toA2ui(quarterlySalesSpec(), { target: "v1.0" });
    const createSurface = (messages[0] as { createSurface: A2uiCreateSurfaceV1 }).createSurface;
    const allowed = new Set([
      "surfaceId",
      "catalogId",
      "sendDataModel",
      "components",
      "dataModel",
      "metadata",
    ]);
    for (const key of Object.keys(createSurface)) {
      expect(allowed.has(key)).toBe(true);
    }
    // required: ["surfaceId"] only, but this profile always includes catalogId + components.
    expect(createSurface.surfaceId).toBeTruthy();
  });

  it("createSurface.components respects ComponentsList's minItems:1 whenever the spec has components", async () => {
    const { messages } = await toA2ui(quarterlySalesSpec(), { target: "v1.0" });
    const createSurface = (messages[0] as { createSurface: A2uiCreateSurfaceV1 }).createSurface;
    expect(createSurface.components!.length).toBeGreaterThanOrEqual(1);
  });

  it("every v1.0 envelope is version + exactly one message key (CreateSurfaceMessage/.../AgentFunctionResponseMessage are all additionalProperties:false with exactly 2 required keys)", async () => {
    const { messages: created } = await toA2ui(quarterlySalesSpec(), { target: "v1.0" });
    const patch: SpecPatch = {
      baseIntentHash: HASH,
      upsert: [{ id: "t", type: "text.heading", props: { text: "x" } }],
    };
    const { messages: patched } = patchToA2ui(patch, undefined, { target: "v1.0" });
    for (const m of [...created, ...patched]) {
      expect(m.version).toBe("v1.0");
      const keys = Object.keys(m).filter((k) => k !== "version");
      expect(keys).toHaveLength(1);
    }
  });

  it("renderer_to_agent action message requires exactly {version, action} with no other top-level key (minProperties:2, maxProperties:2) — fromA2uiEvent's existing input shape carries the action body only, unaffected by the v1.0 envelope wrapper", () => {
    // fromA2uiEvent takes the unwrapped action body (see the "existing `action` overload" test above);
    // this test documents that the real v1.0 envelope around it is `{version, action}` with nothing else,
    // so a host wiring the real wire format must strip the envelope before calling fromA2uiEvent — same as v0.9.1.
    const action = {
      name: "g.rowClick",
      surfaceId: SURFACE,
      sourceComponentId: "g",
      timestamp: "2026-07-18T00:00:00Z",
      context: {},
    };
    const wrapped = { version: "v1.0", action };
    const keys = Object.keys(wrapped).filter((k) => k !== "version");
    expect(keys).toEqual(["action"]);
    expect(fromA2uiEvent(action)).toEqual({ kind: "gui", action: "g.rowClick", params: {} });
  });
});

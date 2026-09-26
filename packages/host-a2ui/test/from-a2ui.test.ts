import { type CanonicalIntent, collectWriteActions, type UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import {
  A2UI_FORWARD_ACTION,
  A2uiIngestError,
  fromA2ui,
  type KohakuSidecar,
  parseInboundA2uiMessage,
  reduceSurfaces,
  type SurfaceState,
  toA2ui,
  toKohakuComponentId,
} from "../src/index.js";

const INTENT: CanonicalIntent = {
  canonical: "a2ui.thirdparty.demo",
  params: {},
  hash: `sha256:${"b".repeat(64)}`,
};

/** Feeds an outbound toA2ui() message sequence through the inbound schema + reducer, as a real receiver would. */
function ingestMessages(messages: unknown[]): SurfaceState {
  let surfaces = new Map<string, SurfaceState>();
  for (const raw of messages) {
    surfaces = reduceSurfaces(surfaces, parseInboundA2uiMessage(raw));
  }
  expect(surfaces.size).toBe(1);
  return [...surfaces.values()][0]!;
}

/** A representative UISpec (heading + chart + button), matching the shapes to-a2ui.ts's own test fixtures use. */
function sampleSpec(): UISpec {
  return {
    kohaku: "0.2",
    intent: {
      canonical: "sales.quarterly_summary",
      params: { fiscalYear: 2026 },
      hash: `sha256:${"a".repeat(64)}`,
    },
    dataVersion: "sales@seed-1",
    components: [
      { id: "root", type: "layout.stack", props: { direction: "vertical" }, children: ["t", "c", "btn"] },
      { id: "t", type: "text.heading", props: { level: 2, text: "FY2026 Q3 Sales" } },
      { id: "c", type: "presentChart", props: { kind: "bar", x: "region", y: "revenue" } },
      { id: "btn", type: "action.button", props: { label: "Recompute", variant: "primary" } },
    ],
    events: [{ on: "btn.press", emit: "action.invoke", payload: {} }],
    provenance: { tier: "L0", composedBy: "test", cache: "miss" },
  };
}

describe("fromA2ui: round trip via sidecar (kohaku's own toA2ui output re-ingested)", () => {
  it("fromA2ui(ingest(toA2ui(spec))) restores every original component and event losslessly via the sidecar (trust: 'trusted')", async () => {
    const spec = sampleSpec();
    const { messages, sidecar } = await toA2ui(spec, { target: "v1.0" });
    const surface = ingestMessages(messages);

    const { spec: restored, losses } = fromA2ui(surface, {
      intent: INTENT,
      dataVersion: "sales@seed-1",
      sidecar,
      trust: "trusted",
    });

    expect(losses).toEqual([]);
    // Sidecar restoration returns each original ComponentNode verbatim.
    const byId = new Map(restored.components.map((c) => [c.id, c] as const));
    expect(byId.get("root")).toEqual(spec.components[0]);
    expect(byId.get("t")).toEqual(spec.components[1]);
    expect(byId.get("c")).toEqual(spec.components[2]);
    expect(byId.get("btn")).toEqual(spec.components[3]);
    // The synthesized "btn__label" wire component is not independently re-emitted.
    expect(byId.has("btn__label")).toBe(false);
    expect(restored.components).toHaveLength(4);
    // The original EventBinding is restored verbatim too (not re-synthesized through attachEvent's
    // forwarding envelope — this is trusted, kohaku-origin data, not a third-party action).
    expect(restored.events).toEqual(spec.events);
  });

  it("without trust: 'trusted', a supplied sidecar is ignored entirely (default is safe against untrusted content)", async () => {
    const spec = sampleSpec();
    const { messages, sidecar } = await toA2ui(spec, { target: "v1.0" });
    const surface = ingestMessages(messages);

    // Same call as above, minus `trust: "trusted"` — the sidecar must not be consulted at all.
    const { spec: restored, losses } = fromA2ui(surface, {
      intent: INTENT,
      dataVersion: "sales@seed-1",
      sidecar,
    });

    // Falls through to the generic best-effort mapping (presentChart is unknown without a catalog, even
    // though the sidecar has a verbatim entry for it) — proving the sidecar had no effect whatsoever.
    expect(losses).toEqual([{ componentId: "c", kind: "unknown-component", detail: expect.any(String) }]);
    const byId = new Map(restored.components.map((c) => [c.id, c] as const));
    expect(byId.get("c")!.type).toBe("presentMarkdown"); // not sidecar's verbatim "presentChart"
    // The event is re-synthesized through the (safe) forwarding envelope, not restored verbatim from the sidecar.
    expect(restored.events).toEqual([
      {
        on: "btn.press",
        emit: "action.invoke",
        payload: { action: A2UI_FORWARD_ACTION, event: "press", context: {} },
      },
    ]);
  });

  it("security: a maliciously-crafted sidecar (an injected event/component the wire never declared) has zero effect without trust: 'trusted'", () => {
    const surface: SurfaceState = {
      surfaceId: "s",
      sendDataModel: false,
      dataModel: {},
      components: { root: { id: "root", component: "Column", children: [] } },
    };
    // Shaped like a real KohakuSidecar, but purely attacker-controlled content — e.g. a compromised or
    // malicious relay claiming "trust me, this is what the original kohaku Spec looked like."
    const maliciousSidecar: KohakuSidecar = {
      components: {
        root: {
          id: "root",
          type: "layout.stack",
          props: {},
          data: { $ref: "query://sales/summary" },
        },
      },
      events: [
        { on: "root.annotate", emit: "action.invoke", payload: { action: "annotate", note: "pwned" } },
      ],
    };

    const { spec } = fromA2ui(surface, {
      intent: INTENT,
      dataVersion: "d1",
      sidecar: maliciousSidecar,
      // trust defaults to "untrusted" — deliberately not set here.
    });

    // The injected component (with its data.$ref) never appears; root is the plain best-effort conversion.
    expect(spec.components).toEqual([
      { id: "root", type: "layout.stack", props: { direction: "vertical" }, children: [] },
    ]);
    // The injected event ("root.annotate") never appears at all — the wire declared no action on root.
    expect(spec.events).toEqual([]);
    expect(collectWriteActions(spec)).toEqual([]);
  });

  it("without a sidecar or a catalog, core-mapped components still round-trip; a non-core type (presentChart) is unmappable", async () => {
    const spec = sampleSpec();
    const { messages } = await toA2ui(spec, { target: "v1.0" });
    const surface = ingestMessages(messages);

    const { spec: restored, losses } = fromA2ui(surface, { intent: INTENT, dataVersion: "sales@seed-1" });
    // root / t / btn round-trip via the core mapping table; c (presentChart) is unknown without a catalog.
    expect(losses).toEqual([{ componentId: "c", kind: "unknown-component", detail: expect.any(String) }]);
    const byId = new Map(restored.components.map((c) => [c.id, c] as const));
    expect(byId.get("root")).toMatchObject({ type: "layout.stack", children: ["t", "c", "btn"] });
    expect(byId.get("t")).toMatchObject({
      type: "text.heading",
      props: { level: 2, text: "FY2026 Q3 Sales" },
    });
    expect(byId.get("c")!.type).toBe("presentMarkdown");
    expect(byId.get("btn")).toMatchObject({
      type: "action.button",
      props: { label: "Recompute", variant: "primary" },
    });
    // The event's "on" survives byte-identically (event.name was already kohaku's own "<id>.<eventName>"
    // form), but the payload is always the safe forwarding envelope, never the raw (here empty) context.
    expect(restored.events).toEqual([
      {
        on: "btn.press",
        emit: "action.invoke",
        payload: { action: A2UI_FORWARD_ACTION, event: "press", context: {} },
      },
    ]);
    expect(byId.has("btn__label")).toBe(false);
  });
});

describe("fromA2ui: core mapping table (Column/Row -> layout.stack, Text -> heading/markdown, Button -> action.button)", () => {
  function surfaceOf(components: SurfaceState["components"]): SurfaceState {
    return { surfaceId: "s", sendDataModel: false, components, dataModel: {} };
  }

  it("Column -> layout.stack (vertical), Row -> layout.stack (horizontal)", () => {
    const surface = surfaceOf({
      root: { id: "root", component: "Column", children: ["row"] },
      row: { id: "row", component: "Row", children: [] },
    });
    const { spec } = fromA2ui(surface, { intent: INTENT, dataVersion: "d1" });
    const byId = new Map(spec.components.map((c) => [c.id, c] as const));
    expect(byId.get("root")).toMatchObject({ type: "layout.stack", props: { direction: "vertical" } });
    expect(byId.get("row")).toMatchObject({ type: "layout.stack", props: { direction: "horizontal" } });
  });

  it("Text h1..h6 -> text.heading(level), plain Text -> presentMarkdown", () => {
    const surface = surfaceOf({
      root: { id: "root", component: "Column", children: ["h", "p"] },
      h: { id: "h", component: "Text", text: "Title", variant: "h3" },
      p: { id: "p", component: "Text", text: "Body copy" },
    });
    const { spec } = fromA2ui(surface, { intent: INTENT, dataVersion: "d1" });
    const byId = new Map(spec.components.map((c) => [c.id, c] as const));
    expect(byId.get("h")).toMatchObject({ type: "text.heading", props: { level: 3, text: "Title" } });
    expect(byId.get("p")).toMatchObject({ type: "presentMarkdown", props: { markdown: "Body copy" } });
  });

  it("Button (child is Text) -> action.button, recovering the label and best-effort variant", () => {
    const surface = surfaceOf({
      root: { id: "root", component: "Column", children: ["btn"] },
      btn: { id: "btn", component: "Button", child: "btn_label", variant: "primary" },
      btn_label: { id: "btn_label", component: "Text", text: "Go" },
    });
    const { spec } = fromA2ui(surface, { intent: INTENT, dataVersion: "d1" });
    const byId = new Map(spec.components.map((c) => [c.id, c] as const));
    expect(byId.get("btn")).toMatchObject({
      type: "action.button",
      props: { label: "Go", variant: "primary" },
    });
    // The label is absorbed into props.label, not independently emitted.
    expect(byId.has("btn_label")).toBe(false);
    expect(spec.components).toHaveLength(2);
  });

  it("a non-'primary' Button variant (e.g. 'default'/'borderless'/unset) reverse-maps to 'secondary'", () => {
    const surface = surfaceOf({
      root: { id: "root", component: "Column", children: ["btn"] },
      btn: { id: "btn", component: "Button", child: "btn_label", variant: "borderless" },
      btn_label: { id: "btn_label", component: "Text", text: "Cancel" },
    });
    const { spec } = fromA2ui(surface, { intent: INTENT, dataVersion: "d1" });
    expect(spec.components.find((c) => c.id === "btn")).toMatchObject({ props: { variant: "secondary" } });
  });
});

describe("fromA2ui: events (action.event -> EventBinding, action.invoke)", () => {
  function surfaceOf(components: SurfaceState["components"]): SurfaceState {
    return { surfaceId: "s", sendDataModel: false, components, dataModel: {} };
  }

  it("maps action.event to an EventBinding with emit: action.invoke, wrapping the resolved context under a fixed forwarding payload", () => {
    const surface = surfaceOf({
      root: { id: "root", component: "Column", children: ["btn"] },
      btn: {
        id: "btn",
        component: "Button",
        child: "btn_label",
        action: { event: { name: "press", context: { source: "toolbar" } } },
      },
      btn_label: { id: "btn_label", component: "Text", text: "Go" },
    });
    const { spec } = fromA2ui(surface, { intent: INTENT, dataVersion: "d1" });
    expect(spec.events).toEqual([
      {
        on: "btn.press",
        emit: "action.invoke",
        payload: { action: A2UI_FORWARD_ACTION, event: "press", context: { source: "toolbar" } },
      },
    ]);
  });

  it("security: an agent-controlled context.action can never surface as the write action collectWriteActions resolves", () => {
    const surface = surfaceOf({
      root: { id: "root", component: "Column", children: ["btn"] },
      btn: {
        id: "btn",
        component: "Button",
        child: "btn_label",
        // A malicious/compromised third-party agent tries to smuggle a real write-action name through the
        // (otherwise wholly agent-controlled) event context.
        action: { event: { name: "press", context: { action: "annotate", orderId: "123" } } },
      },
      btn_label: { id: "btn_label", component: "Text", text: "Go" },
    });
    const { spec } = fromA2ui(surface, { intent: INTENT, dataVersion: "d1" });
    // The smuggled "action" value survives only nested under payload.context, never at payload.action.
    expect(spec.events[0]!.payload).toEqual({
      action: A2UI_FORWARD_ACTION,
      event: "press",
      context: { action: "annotate", orderId: "123" },
    });
    expect(collectWriteActions(spec)).toEqual([A2UI_FORWARD_ACTION]);
  });

  it("security: a catalog-verbatim component's own 'action' field is always the structural A2UI action descriptor, never copied into props", () => {
    const surface = surfaceOf({
      root: { id: "root", component: "Column", children: ["c"] },
      c: {
        id: "c",
        component: "presentChart",
        kind: "bar",
        action: { event: { name: "select", context: {} } },
      },
    });
    const { spec } = fromA2ui(surface, {
      intent: INTENT,
      dataVersion: "d1",
      catalog: { has: () => true },
    });
    const chart = spec.components.find((c) => c.id === "c")!;
    expect(chart.props).not.toHaveProperty("action");
    expect(collectWriteActions(spec)).toEqual([A2UI_FORWARD_ACTION]);
  });

  it("sanitizes a non-regex-compliant event name deterministically", () => {
    const surface = surfaceOf({
      root: { id: "root", component: "Column", children: ["btn"] },
      btn: {
        id: "btn",
        component: "Button",
        child: "btn_label",
        action: { event: { name: "on-click!", context: {} } },
      },
      btn_label: { id: "btn_label", component: "Text", text: "Go" },
    });
    const { spec } = fromA2ui(surface, { intent: INTENT, dataVersion: "d1" });
    expect(spec.events[0]!.on).toBe("btn.onclick");
  });

  it("a functionCall action produces no EventBinding (client-local, nothing to forward)", () => {
    const surface = surfaceOf({
      root: { id: "root", component: "Column", children: ["btn"] },
      btn: {
        id: "btn",
        component: "Button",
        child: "btn_label",
        action: { functionCall: { call: "openUrl", args: {} } },
      },
      btn_label: { id: "btn_label", component: "Text", text: "Go" },
    });
    const { spec, losses } = fromA2ui(surface, { intent: INTENT, dataVersion: "d1" });
    expect(spec.events).toEqual([]);
    expect(losses).toEqual([]);
  });
});

describe("fromA2ui: kohaku catalog passthrough (catalog.has)", () => {
  function surfaceOf(components: SurfaceState["components"]): SurfaceState {
    return { surfaceId: "s", sendDataModel: false, components, dataModel: {} };
  }

  it("passes props through verbatim for a component the supplied catalog recognizes", () => {
    const surface = surfaceOf({
      root: { id: "root", component: "Column", children: ["c"] },
      c: { id: "c", component: "presentChart", kind: "bar", x: "region", y: "revenue" },
    });
    const { spec, losses } = fromA2ui(surface, {
      intent: INTENT,
      dataVersion: "d1",
      catalog: { has: (t) => t === "presentChart" },
    });
    expect(losses).toEqual([]);
    expect(spec.components.find((c) => c.id === "c")).toMatchObject({
      type: "presentChart",
      props: { kind: "bar", x: "region", y: "revenue" },
    });
  });
});

describe("fromA2ui: {path} data binding resolution", () => {
  function surfaceOf(
    components: SurfaceState["components"],
    dataModel: SurfaceState["dataModel"],
  ): SurfaceState {
    return { surfaceId: "s", sendDataModel: false, components, dataModel };
  }

  it("snapshots a {path} binding from the data model to a literal, recording a binding-snapshotted loss", () => {
    const surface = surfaceOf(
      { root: { id: "root", component: "Text", text: { path: "/greeting" } } },
      { greeting: "hello" },
    );
    const { spec, losses } = fromA2ui(surface, { intent: INTENT, dataVersion: "d1" });
    expect(spec.components[0]).toMatchObject({ type: "presentMarkdown", props: { markdown: "hello" } });
    expect(losses).toEqual([
      { componentId: "root", kind: "binding-snapshotted", detail: expect.any(String) },
    ]);
    // A binding-snapshotted loss is recorded on provenance.fallback too (kind: negotiation).
    expect(spec.provenance.fallback).toMatchObject({ from: "root", kind: "negotiation" });
  });

  it("a {path} binding on an ordinary prop (not 'data') is always snapshotted, even when bindPath could resolve it", () => {
    const surface = surfaceOf(
      { root: { id: "root", component: "presentChart", kind: "bar", x: { path: "/x" }, y: "revenue" } },
      { x: "region" },
    );
    const bindPath = (path: string): { $ref: string } | undefined =>
      path === "/x" ? { $ref: "query://sales/summary" } : undefined;
    const { spec, losses } = fromA2ui(surface, {
      intent: INTENT,
      dataVersion: "d1",
      catalog: { has: () => true },
      bindPath,
    });
    // bindPath is only ever consulted for the "data" prop (see the describe block below) — an ordinary prop
    // like "x" has no structural place for a live reference, so it is always a literal snapshot + a loss,
    // regardless of what bindPath would have returned for that same path.
    expect(losses).toEqual([
      { componentId: "root", kind: "binding-snapshotted", detail: expect.any(String) },
    ]);
    expect(spec.components[0]!.props["x"]).toBe("region");
  });
});

describe("fromA2ui: bindPath makes a component's 'data' prop a live ComponentNode.data.$ref", () => {
  function surfaceOf(
    components: SurfaceState["components"],
    dataModel: SurfaceState["dataModel"],
  ): SurfaceState {
    return { surfaceId: "s", sendDataModel: false, components, dataModel };
  }

  it("a 'data' prop bound to {path}, resolved by bindPath, becomes ComponentNode.data.$ref (not a props.data literal)", () => {
    const surface = surfaceOf(
      { root: { id: "root", component: "presentChart", kind: "bar", data: { path: "/rows" } } },
      { rows: [{ region: "west", revenue: 100 }] },
    );
    const { spec, losses } = fromA2ui(surface, {
      intent: INTENT,
      dataVersion: "d1",
      catalog: { has: () => true },
      bindPath: (path) => (path === "/rows" ? { $ref: "query://sales/summary" } : undefined),
    });
    expect(losses).toEqual([]);
    const root = spec.components[0]!;
    expect(root.data).toEqual({ $ref: "query://sales/summary" });
    expect(root.props).not.toHaveProperty("data");
  });

  it("without bindPath (or when it declines), a 'data' prop bound to {path} falls back to an ordinary literal snapshot in props.data", () => {
    const surface = surfaceOf(
      { root: { id: "root", component: "presentChart", kind: "bar", data: { path: "/rows" } } },
      { rows: [{ region: "west", revenue: 100 }] },
    );
    const { spec: withoutBindPath, losses: lossesWithout } = fromA2ui(surface, {
      intent: INTENT,
      dataVersion: "d1",
      catalog: { has: () => true },
    });
    expect(lossesWithout).toEqual([
      { componentId: "root", kind: "binding-snapshotted", detail: expect.any(String) },
    ]);
    expect(withoutBindPath.components[0]!.data).toBeUndefined();
    expect(withoutBindPath.components[0]!.props["data"]).toEqual([{ region: "west", revenue: 100 }]);

    const { spec: declined, losses: lossesDeclined } = fromA2ui(surface, {
      intent: INTENT,
      dataVersion: "d1",
      catalog: { has: () => true },
      bindPath: () => undefined,
    });
    expect(lossesDeclined).toEqual([
      { componentId: "root", kind: "binding-snapshotted", detail: expect.any(String) },
    ]);
    expect(declined.components[0]!.data).toBeUndefined();
  });

  it("a 'data' prop that is not a {path} binding (an ordinary literal) is unaffected", () => {
    const surface = surfaceOf(
      { root: { id: "root", component: "presentChart", kind: "bar", data: "not-a-binding" } },
      {},
    );
    const { spec, losses } = fromA2ui(surface, {
      intent: INTENT,
      dataVersion: "d1",
      catalog: { has: () => true },
      bindPath: () => ({ $ref: "query://should-not-be-used" }),
    });
    expect(losses).toEqual([]);
    expect(spec.components[0]!.data).toBeUndefined();
    expect(spec.components[0]!.props["data"]).toBe("not-a-binding");
  });
});

describe("fromA2ui: unmappable handling (fallback vs. reject)", () => {
  function surfaceOf(components: SurfaceState["components"]): SurfaceState {
    return { surfaceId: "s", sendDataModel: false, components, dataModel: {} };
  }

  it("unknown-component: default (fallback) replaces it with a deterministic presentMarkdown placeholder", () => {
    const surface = surfaceOf({
      root: { id: "root", component: "Column", children: ["mystery"] },
      mystery: { id: "mystery", component: "SomeVendorWidget", foo: "bar" },
    });
    const { spec, losses } = fromA2ui(surface, { intent: INTENT, dataVersion: "d1" });
    const mystery = spec.components.find((c) => c.id === "mystery")!;
    expect(mystery.type).toBe("presentMarkdown");
    expect(String(mystery.props["markdown"])).toContain("Unsupported content (unknown-component)");
    expect(losses).toEqual([
      { componentId: "mystery", kind: "unknown-component", detail: expect.any(String) },
    ]);
    expect(spec.provenance.fallback).toMatchObject({ from: "mystery", kind: "negotiation" });
  });

  it("unknown-component: unmappable: reject fails the whole conversion", () => {
    const surface = surfaceOf({
      root: { id: "root", component: "Column", children: ["mystery"] },
      mystery: { id: "mystery", component: "SomeVendorWidget", foo: "bar" },
    });
    expect(() => fromA2ui(surface, { intent: INTENT, dataVersion: "d1", unmappable: "reject" })).toThrow(
      A2uiIngestError,
    );
  });

  it("template-children: a data-bound repeated list is not representable as a static children array", () => {
    const surface = surfaceOf({
      root: { id: "root", component: "Column", children: { path: "/items", componentId: "item_template" } },
    });
    const { spec, losses } = fromA2ui(surface, { intent: INTENT, dataVersion: "d1" });
    expect(spec.components[0]!.type).toBe("presentMarkdown");
    expect(losses[0]!.kind).toBe("template-children");
  });

  it("function-call-value: a computed prop value demotes the whole containing component", () => {
    const surface = surfaceOf({
      root: {
        id: "root",
        component: "presentChart",
        kind: "bar",
        x: "region",
        y: { call: "computeTotal", args: {} },
      },
    });
    const { spec, losses } = fromA2ui(surface, {
      intent: INTENT,
      dataVersion: "d1",
      catalog: { has: () => true },
    });
    expect(spec.components[0]!.type).toBe("presentMarkdown");
    expect(losses[0]!.kind).toBe("function-call-value");
  });

  it("reject mode aborts on the first unmappable value found anywhere in the surface", () => {
    const surface = surfaceOf({
      root: {
        id: "root",
        component: "presentChart",
        kind: "bar",
        x: "region",
        y: { call: "computeTotal", args: {} },
      },
    });
    expect(() =>
      fromA2ui(surface, {
        intent: INTENT,
        dataVersion: "d1",
        catalog: { has: () => true },
        unmappable: "reject",
      }),
    ).toThrow(A2uiIngestError);
  });
});

describe("toKohakuComponentId: id sanitization", () => {
  it("leaves an already-valid id unchanged", () => {
    expect(toKohakuComponentId("root")).toBe("root");
    expect(toKohakuComponentId("btn-1")).toBe("btn-1");
  });

  it("deterministically sanitizes an id violating kohaku's ComponentIdSchema", () => {
    expect(toKohakuComponentId("1st.item")).toBe("c_1st_item");
    expect(toKohakuComponentId("1st.item")).toBe(toKohakuComponentId("1st.item"));
  });
});

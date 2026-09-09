import type { ComponentNode, UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { resolveEmit, resolvePayloadTemplate } from "../src/index.js";

type EventDecl = { on: string; emit: string; payload: Record<string, unknown> };

function makeSpec(events: EventDecl[]): UISpec {
  return { events } as unknown as UISpec;
}
function makeNode(id: string, props: Record<string, unknown> = {}): ComponentNode {
  return { id, type: "x", props } as unknown as ComponentNode;
}

describe("resolveEmit (SPEC-EVT-002 gatekeeper)", () => {
  it("drops undeclared events", () => {
    const spec = makeSpec([]);
    expect(resolveEmit(spec, makeNode("t"), "rowClick", {})).toEqual({ kind: "drop" });
  });

  it("declared state.set returns key/value (does not forward to the server)", () => {
    const spec = makeSpec([
      { on: "sel.change", emit: "state.set", payload: { key: "region", value: "$value" } },
    ]);
    const r = resolveEmit(spec, makeNode("sel"), "change", { value: "japan" });
    expect(r).toEqual({ kind: "state.set", key: "region", value: "japan" });
  });

  it("drops state.set when key is not a string", () => {
    const spec = makeSpec([{ on: "sel.change", emit: "state.set", payload: { value: "$value" } }]);
    expect(resolveEmit(spec, makeNode("sel"), "change", { value: "x" })).toEqual({ kind: "drop" });
  });

  it("returns null when state.set value is unspecified", () => {
    const spec = makeSpec([{ on: "sel.change", emit: "state.set", payload: { key: "region" } }]);
    expect(resolveEmit(spec, makeNode("sel"), "change", {})).toEqual({
      kind: "state.set",
      key: "region",
      value: null,
    });
  });

  it("declared action.invoke returns a forward SurfaceEvent", () => {
    const spec = makeSpec([{ on: "row1.rowClick", emit: "action.invoke", payload: { id: "$row.id" } }]);
    const r = resolveEmit(spec, makeNode("row1"), "rowClick", { row: { id: 7 } });
    expect(r).toEqual({
      kind: "forward",
      event: { componentId: "row1", on: "row1.rowClick", emit: "action.invoke", payload: { id: 7 } },
    });
  });

  it("auto-supplies the row context when runtime.row is unspecified (presentList)", () => {
    const spec = makeSpec([
      { on: "row1.rowClick", emit: "intent.patch", payload: { region: "$row.region" } },
    ]);
    const r = resolveEmit(spec, makeNode("row1"), "rowClick", {}, { region: "japan" });
    expect(r).toMatchObject({ kind: "forward", event: { payload: { region: "japan" } } });
  });

  it("runtime.row takes priority over the row context when explicit", () => {
    const spec = makeSpec([
      { on: "row1.rowClick", emit: "intent.patch", payload: { region: "$row.region" } },
    ]);
    const r = resolveEmit(spec, makeNode("row1"), "rowClick", { row: { region: "us" } }, { region: "japan" });
    expect(r).toMatchObject({ kind: "forward", event: { payload: { region: "us" } } });
  });
});

describe("resolvePayloadTemplate", () => {
  it("resolves $row.<key> / $value / $value.<field> / literals", () => {
    const out = resolvePayloadTemplate(
      { a: "$row.id", b: "$value", c: "$value.note", d: "lit", e: "$row.missing" },
      { row: { id: 3 }, value: { note: "hi" } },
    );
    expect(out).toEqual({ a: 3, b: { note: "hi" }, c: "hi", d: "lit", e: null });
  });

  it("$value.<field> is null when $value is not an object", () => {
    expect(resolvePayloadTemplate({ c: "$value.note" }, { value: "scalar" })).toEqual({ c: null });
  });
});

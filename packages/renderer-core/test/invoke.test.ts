import type { ComponentNode, UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { resolveActionName, resolveInvokeTarget } from "../src/index.js";

type EventDecl = { on: string; emit: string; payload: Record<string, unknown> };

function makeSpec(events: EventDecl[]): UISpec {
  return { events } as unknown as UISpec;
}
function makeNode(id: string, props: Record<string, unknown> = {}): ComponentNode {
  return { id, type: "actionButton", props } as unknown as ComponentNode;
}

describe("resolveInvokeTarget (deciding direct execution of action.invoke)", () => {
  it("forward when the declaration is not action.invoke", () => {
    const spec = makeSpec([{ on: "b.click", emit: "intent.patch", payload: {} }]);
    expect(
      resolveInvokeTarget(spec, makeNode("b", { action: "x" }), "click", {}, { hasBinding: true }),
    ).toEqual({
      kind: "forward",
    });
  });

  it("forward when binding is unset (hasBinding=false)", () => {
    const spec = makeSpec([{ on: "b.click", emit: "action.invoke", payload: {} }]);
    expect(
      resolveInvokeTarget(spec, makeNode("b", { action: "x" }), "click", {}, { hasBinding: false }),
    ).toEqual({
      kind: "forward",
    });
  });

  it("forward when the action name cannot be determined", () => {
    const spec = makeSpec([{ on: "b.click", emit: "action.invoke", payload: {} }]);
    expect(resolveInvokeTarget(spec, makeNode("b"), "click", {}, { hasBinding: true })).toEqual({
      kind: "forward",
    });
  });

  it("returns an invoke with props.action and a resolved payload", () => {
    const spec = makeSpec([{ on: "b.click", emit: "action.invoke", payload: { id: "$row.id" } }]);
    const r = resolveInvokeTarget(
      spec,
      makeNode("b", { action: "archive" }),
      "click",
      { row: { id: 9 } },
      { hasBinding: true },
    );
    expect(r).toEqual({ kind: "invoke", action: "archive", payload: { id: 9 } });
  });

  it("can also take the action name from payload.action", () => {
    const spec = makeSpec([
      { on: "b.click", emit: "action.invoke", payload: { action: "del", id: "$value.id" } },
    ]);
    const r = resolveInvokeTarget(spec, makeNode("b"), "click", { value: { id: 2 } }, { hasBinding: true });
    expect(r).toEqual({ kind: "invoke", action: "del", payload: { action: "del", id: 2 } });
  });

  it("auto-supplies the row context when runtime.row is unspecified", () => {
    const spec = makeSpec([{ on: "b.click", emit: "action.invoke", payload: { region: "$row.region" } }]);
    const r = resolveInvokeTarget(
      spec,
      makeNode("b", { action: "a" }),
      "click",
      {},
      { hasBinding: true, row: { region: "japan" } },
    );
    expect(r).toMatchObject({ kind: "invoke", action: "a", payload: { region: "japan" } });
  });
});

describe("resolveActionName", () => {
  it("prefers props.action, then payload.action, then undefined if neither", () => {
    expect(resolveActionName(makeNode("b", { action: "p" }), { action: "q" })).toBe("p");
    expect(resolveActionName(makeNode("b"), { action: "q" })).toBe("q");
    expect(resolveActionName(makeNode("b"), {})).toBeUndefined();
    expect(resolveActionName(makeNode("b", { action: "" }), {})).toBeUndefined();
  });
});

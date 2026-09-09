import { parseSpec, type UISpec } from "@kohaku-ui/spec-core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createCoreRegistry } from "../src/core/index.js";
import { RendererProvider, SpecView, type SurfaceEvent } from "../src/index.js";

const INTENT = { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L0", composedBy: "test", cache: "hit" } as const;

function buttonSpec(props: Record<string, unknown>, withEvent = true): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "v1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["btn1"] },
      { id: "btn1", type: "action.button", props },
    ],
    events: withEvent ? [{ on: "btn1.press", emit: "action.invoke", payload: { action: "run" } }] : [],
    provenance: PROVENANCE,
  });
}

function renderSpec(spec: UISpec, onEvent?: (e: SurfaceEvent) => void) {
  return render(
    <RendererProvider value={{ impls: createCoreRegistry(), theme: {}, onEvent }}>
      <SpecView spec={spec} />
    </RendererProvider>,
  );
}

describe("action.button", () => {
  it("press is emitted as a declared event", () => {
    const events: SurfaceEvent[] = [];
    renderSpec(buttonSpec({ label: "Run" }), (e) => events.push(e));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(events).toEqual([
      { componentId: "btn1", on: "btn1.press", emit: "action.invoke", payload: { action: "run" } },
    ]);
  });

  it("when disabled, the button is inactive and does not fire", () => {
    const onEvent = vi.fn();
    renderSpec(buttonSpec({ label: "Run", disabled: true }), onEvent);
    const btn = screen.getByRole("button", { name: "Run" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("if press is undeclared it is discarded (governance)", () => {
    const onEvent = vi.fn();
    renderSpec(buttonSpec({ label: "Run" }, false), onEvent);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(onEvent).not.toHaveBeenCalled();
  });
});

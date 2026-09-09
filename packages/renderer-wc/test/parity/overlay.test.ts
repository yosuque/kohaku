// Parity of the overlay parts (overlay.dialog / overlay.toast).
// - Structural parity: for an open dialog / toast, React tree ≡ WC tree (semantic equivalence of role / aria / style).
// - Behavior parity: open/close via visibleWhen and close governance (self-contained within state.set = no forward / undeclared is dropped)
//   produce the same external observation in both renderers.

import { parseSpec, type UISpec } from "@kohaku-ui/spec-core";
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupPair,
  flushReact,
  renderPair,
  renderReact,
  renderWc,
  type SurfaceEvent,
  tick,
} from "./render-both.js";

const INTENT = { canonical: "parity.overlay", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L0", composedBy: "parity", cache: "hit" } as const;

function spec(partial: {
  components: unknown[];
  events?: unknown[];
  state: Record<string, unknown>;
}): UISpec {
  return parseSpec({
    kohaku: "0.2",
    intent: INTENT,
    dataVersion: "v1",
    state: partial.state,
    components: partial.components,
    events: partial.events ?? [],
    provenance: PROVENANCE,
  });
}

/** Launcher button + confirmation dialog. Open/close is state.open + visibleWhen. */
function confirmSpec(): UISpec {
  return spec({
    state: { open: false },
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["opener", "dlg"] },
      { id: "opener", type: "action.button", props: { label: "Delete" } },
      {
        id: "dlg",
        type: "overlay.dialog",
        props: {
          title: "Are you sure you want to delete?",
          description: "This cannot be undone.",
          variant: "danger",
        },
        children: ["ok"],
        visibleWhen: { ref: "$state.open", eq: true },
      },
      { id: "ok", type: "action.button", props: { label: "OK" } },
    ],
    events: [
      { on: "opener.press", emit: "state.set", payload: { key: "open", value: true } },
      { on: "dlg.close", emit: "state.set", payload: { key: "open", value: false } },
    ],
  });
}

describe("overlay structure parity: React tree ≡ WC tree", () => {
  afterEach(() => cleanupPair());

  it("an open overlay.dialog (role/aria/style) matches", async () => {
    const openSpec = spec({
      state: { open: true },
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["dlg"] },
        {
          id: "dlg",
          type: "overlay.dialog",
          props: { title: "Confirm", description: "Are you sure?" },
          children: ["ok"],
          visibleWhen: { ref: "$state.open", eq: true },
        },
        { id: "ok", type: "action.button", props: { label: "OK" } },
      ],
      events: [{ on: "dlg.close", emit: "state.set", payload: { key: "open", value: false } }],
    });
    const { react, wc } = await renderPair(openSpec, { theme: {} });
    expect(wc).toEqual(react);
  });

  it("overlay.toast (role/style) matches", async () => {
    const toastSpec = spec({
      state: { toastOpen: true },
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["t"] },
        {
          id: "t",
          type: "overlay.toast",
          props: { message: "Saved", tone: "success" },
          visibleWhen: { ref: "$state.toastOpen", eq: true },
        },
      ],
      events: [{ on: "t.dismiss", emit: "state.set", payload: { key: "toastOpen", value: false } }],
    });
    const { react, wc } = await renderPair(toastSpec, { theme: {} });
    expect(wc).toEqual(react);
  });
});

describe("overlay behavior parity: open/close and close control are identical across both renderers", () => {
  afterEach(() => cleanupPair());

  it("click opens and Esc closes; close is self-contained in state.set and not forwarded (both match)", async () => {
    // React
    const rEvents: SurfaceEvent[] = [];
    const { container } = await renderReact(confirmSpec(), {}, (e) => rEvents.push(e));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    fireEvent.click(container.querySelector('[data-kohaku="opener"]')!);
    await flushReact();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    fireEvent.keyDown(container.querySelector('[role="dialog"]')!, { key: "Escape" });
    await flushReact();
    const reactOpenClose = { afterEsc: container.querySelector('[role="dialog"]') != null, events: rEvents };

    // WC
    const wEvents: SurfaceEvent[] = [];
    const { surface } = await renderWc(confirmSpec(), {}, (e) => wEvents.push(e));
    const shadow = surface.shadowRoot!;
    expect(shadow.querySelector('[role="dialog"]')).toBeNull();
    (shadow.querySelector('[data-kohaku="opener"]') as HTMLButtonElement).click();
    await tick();
    expect(shadow.querySelector('[role="dialog"]')).not.toBeNull();
    shadow
      .querySelector('[role="dialog"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    const wcOpenClose = { afterEsc: shadow.querySelector('[role="dialog"]') != null, events: wEvents };

    // Both: Esc closes (afterEsc=false), and forward events are 0 (state.set is self-contained within the Renderer).
    expect(reactOpenClose).toEqual({ afterEsc: false, events: [] });
    expect(wcOpenClose).toEqual(reactOpenClose);
  });

  it("without close declared, Esc is dropped and the dialog stays open (both match)", async () => {
    const undeclared = spec({
      state: { open: true },
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["dlg"] },
        {
          id: "dlg",
          type: "overlay.dialog",
          props: { title: "undeclared" },
          children: ["ok"],
          visibleWhen: { ref: "$state.open", eq: true },
        },
        { id: "ok", type: "action.button", props: { label: "OK" } },
      ],
      events: [],
    });

    const rEvents: SurfaceEvent[] = [];
    const { container } = await renderReact(undeclared, {}, (e) => rEvents.push(e));
    fireEvent.keyDown(container.querySelector('[role="dialog"]')!, { key: "Escape" });
    await flushReact();
    const react = { stillOpen: container.querySelector('[role="dialog"]') != null, events: rEvents };

    const wEvents: SurfaceEvent[] = [];
    const { surface } = await renderWc(undeclared, {}, (e) => wEvents.push(e));
    surface
      .shadowRoot!.querySelector('[role="dialog"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    const wc = { stillOpen: surface.shadowRoot!.querySelector('[role="dialog"]') != null, events: wEvents };

    expect(react).toEqual({ stillOpen: true, events: [] });
    expect(wc).toEqual(react);
  });
});

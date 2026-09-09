// WC implementation of the overlay parts (overlay.dialog / overlay.toast). Performs verification semantically equivalent
// to renderer-react's overlay.test.tsx (open/close, focus trap, focus return, Esc, backdrop click, timer, dropping an
// undeclared close) on the shadow DOM. Focus is observed via the shadow root's activeElement.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { KohakuSurface } from "../src/index.js";
import { buildSpec, byKohaku, collectEvents, mount, tick } from "./util.js";

/** Launcher button + confirmation dialog (OK / cancel in the body). Open/close is state.open + visibleWhen. */
function confirmSpec() {
  return buildSpec({
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
        children: ["ok", "cancel"],
        visibleWhen: { ref: "$state.open", eq: true },
      },
      { id: "ok", type: "action.button", props: { label: "OK" } },
      { id: "cancel", type: "action.button", props: { label: "Cancel" } },
    ],
    events: [
      { on: "opener.press", emit: "state.set", payload: { key: "open", value: true } },
      { on: "dlg.close", emit: "state.set", payload: { key: "open", value: false } },
    ],
  });
}

/** The currently-focused element within the shadow root. */
function activeIn(surface: KohakuSurface): Element | null {
  return surface.shadowRoot!.activeElement;
}

describe("overlay.dialog (WC): open/close and focus management", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("when visibleWhen is false it is not built; opens via state.set with role/aria", async () => {
    const surface = mount(confirmSpec());
    expect(byKohaku(surface, "dlg")).toBeNull();

    const opener = byKohaku(surface, "opener") as HTMLButtonElement;
    opener.focus();
    opener.click();
    await tick();

    const box = surface.shadowRoot!.querySelector('[role="dialog"]')!;
    expect(box.getAttribute("aria-modal")).toBe("true");
    expect(box.getAttribute("aria-labelledby")).toBe("dlg-title");
    expect(surface.shadowRoot!.getElementById("dlg-title")?.textContent).toBe(
      "Are you sure you want to delete?",
    );
    expect(box.getAttribute("aria-describedby")).toBe("dlg-desc");
  });

  it("on open, focus moves to the first focusable element (the close button)", async () => {
    const surface = mount(confirmSpec());
    const opener = byKohaku(surface, "opener") as HTMLButtonElement;
    opener.focus();
    opener.click();
    await tick();
    const closeBtn = surface.shadowRoot!.querySelector('[aria-label="Close"]')!;
    expect(activeIn(surface)).toBe(closeBtn);
  });

  it("focus trap: Tab cycles last→first, Shift+Tab cycles first→last", async () => {
    const surface = mount(confirmSpec());
    const opener = byKohaku(surface, "opener") as HTMLButtonElement;
    opener.focus();
    opener.click();
    await tick();
    const closeBtn = surface.shadowRoot!.querySelector('[aria-label="Close"]') as HTMLButtonElement;
    const cancel = byKohaku(surface, "cancel") as HTMLButtonElement;

    cancel.focus();
    cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(activeIn(surface)).toBe(closeBtn);

    closeBtn.focus();
    closeBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(activeIn(surface)).toBe(cancel);
  });

  it("Esc fires close → closes via state.set and focus returns to the opener", async () => {
    const surface = mount(confirmSpec());
    const opener = byKohaku(surface, "opener") as HTMLButtonElement;
    opener.focus();
    opener.click();
    await tick();
    expect(byKohaku(surface, "dlg")).not.toBeNull();

    const box = surface.shadowRoot!.querySelector('[role="dialog"]')!;
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(byKohaku(surface, "dlg")).toBeNull();
    expect(activeIn(surface)).toBe(opener);
  });

  it("clicking the backdrop closes, clicking inside the box does not", async () => {
    const surface = mount(confirmSpec());
    (byKohaku(surface, "opener") as HTMLButtonElement).click();
    await tick();
    // Clicking inside the box (the heading) does not close.
    surface.shadowRoot!.getElementById("dlg-title")!.click();
    expect(byKohaku(surface, "dlg")).not.toBeNull();
    // Clicking the backdrop (overlay itself) closes.
    (byKohaku(surface, "dlg") as HTMLElement).click();
    expect(byKohaku(surface, "dlg")).toBeNull();
  });

  it("without close declared, Esc is discarded (control) and the dialog stays open with no forward", async () => {
    const spec = buildSpec({
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
    const surface = mount(spec);
    const events = collectEvents(surface);
    await tick();
    expect(byKohaku(surface, "dlg")).not.toBeNull();
    const box = surface.shadowRoot!.querySelector('[role="dialog"]')!;
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(byKohaku(surface, "dlg")).not.toBeNull();
    expect(events).toEqual([]);
  });
});

describe("overlay.toast (WC): auto-dismiss timer and role", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  function toastSpec(props: Record<string, unknown>) {
    return buildSpec({
      state: { toastOpen: true },
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["t"] },
        {
          id: "t",
          type: "overlay.toast",
          props,
          visibleWhen: { ref: "$state.toastOpen", eq: true },
        },
      ],
      events: [{ on: "t.dismiss", emit: "state.set", payload: { key: "toastOpen", value: false } }],
    });
  }

  it("error tone is role=alert, otherwise role=status", () => {
    const s1 = mount(toastSpec({ message: "failed", tone: "error" }));
    expect(byKohaku(s1, "t")!.getAttribute("role")).toBe("alert");
    const s2 = mount(toastSpec({ message: "Save", tone: "success" }));
    expect(byKohaku(s2, "t")!.getAttribute("role")).toBe("status");
  });

  it("after durationMs elapses, dismiss (state.set) fires and the toast disappears", () => {
    vi.useFakeTimers();
    const surface = mount(toastSpec({ message: "Saved", durationMs: 3000 }));
    expect(byKohaku(surface, "t")).not.toBeNull();
    vi.advanceTimersByTime(3000);
    expect(byKohaku(surface, "t")).toBeNull();
  });

  it("when durationMs is omitted, no timer is set and it does not disappear", () => {
    vi.useFakeTimers();
    const surface = mount(toastSpec({ message: "Close it manually" }));
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60000);
    expect(byKohaku(surface, "t")).not.toBeNull();
  });

  it("the close button fires dismiss to close manually", () => {
    const surface = mount(toastSpec({ message: "Saved" }));
    (
      surface.shadowRoot!.querySelector('[data-kohaku="t"] [aria-label="Close"]') as HTMLButtonElement
    ).click();
    expect(byKohaku(surface, "t")).toBeNull();
  });

  it("on disconnect, clears the timer (no late firing)", () => {
    vi.useFakeTimers();
    const surface = mount(toastSpec({ message: "Saved", durationMs: 5000 }));
    expect(vi.getTimerCount()).toBe(1);
    surface.remove();
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { parseSpec, type UISpec } from "@kohaku-ui/spec-core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoreRegistry } from "../src/core/index.js";
import { RendererProvider, SpecView, type SurfaceEvent } from "../src/index.js";

const INTENT = { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L0", composedBy: "test", cache: "hit" } as const;

function makeSpec(partial: {
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

function renderSpec(spec: UISpec, onEvent?: (e: SurfaceEvent) => void) {
  return render(
    <RendererProvider
      value={{ impls: createCoreRegistry(), theme: {}, ...(onEvent != null ? { onEvent } : {}) }}
    >
      <SpecView spec={spec} />
    </RendererProvider>,
  );
}

/** A launcher button + a confirmation dialog (OK / cancel in the body). Open/close via state.open + visibleWhen. */
function confirmSpec(): UISpec {
  return makeSpec({
    state: { open: false },
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["opener", "dlg"] },
      { id: "opener", type: "action.button", props: { label: "Delete" } },
      {
        id: "dlg",
        type: "overlay.dialog",
        props: {
          title: "Are you sure you want to delete?",
          description: "This action cannot be undone.",
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

function dialogEl(): HTMLElement {
  return screen.getByRole("dialog");
}

describe("overlay.dialog (React): open/close and focus management", () => {
  afterEach(() => cleanup());

  it("when visibleWhen is false it is not rendered, and state.set opens it", () => {
    renderSpec(confirmSpec());
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByText("Delete"));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    // role/aria: aria-modal + title/description association.
    const dlg = dialogEl();
    expect(dlg.getAttribute("aria-modal")).toBe("true");
    expect(dlg.getAttribute("aria-labelledby")).toBe("dlg-title");
    expect(document.getElementById("dlg-title")?.textContent).toBe("Are you sure you want to delete?");
    expect(dlg.getAttribute("aria-describedby")).toBe("dlg-desc");
  });

  it("on open, focus moves to the first focusable element (the × button)", () => {
    renderSpec(confirmSpec());
    const opener = screen.getByText("Delete");
    opener.focus();
    fireEvent.click(opener);
    // The first focusable element is the close (×) button.
    const closeBtn = screen.getByLabelText("Close");
    expect(document.activeElement).toBe(closeBtn);
  });

  it("focus trap: Tab cycles last→first, Shift+Tab cycles first→last", () => {
    renderSpec(confirmSpec());
    fireEvent.click(screen.getByText("Delete"));
    const closeBtn = screen.getByLabelText("Close");
    const cancel = screen.getByText("Cancel");

    // Tab on the last element (cancel) → to the first (×).
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(document.activeElement).toBe(closeBtn);

    // Shift+Tab on the first (×) → to the last (cancel).
    closeBtn.focus();
    fireEvent.keyDown(closeBtn, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cancel);
  });

  it("Esc fires close → state.set closes it, and focus returns to the launcher", () => {
    renderSpec(confirmSpec());
    const opener = screen.getByText("Delete");
    opener.focus();
    fireEvent.click(opener);
    expect(screen.queryByRole("dialog")).not.toBeNull();

    fireEvent.keyDown(dialogEl(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    // Return focus to the launcher.
    expect(document.activeElement).toBe(opener);
  });

  it("a backdrop click closes it, and a click inside the box does not", () => {
    renderSpec(confirmSpec());
    fireEvent.click(screen.getByText("Delete"));
    // A click inside the box (the title) does not close.
    fireEvent.click(screen.getByText("Are you sure you want to delete?"));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    // A click on the backdrop (the overlay itself = data-kohaku="dlg") closes it.
    fireEvent.click(document.querySelector('[data-kohaku="dlg"]')!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("if close is undeclared, Esc is discarded (governance), the dialog stays open, and onEvent is not called", () => {
    const spec = makeSpec({
      state: { open: true },
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["dlg"] },
        {
          id: "dlg",
          type: "overlay.dialog",
          props: { title: "Undeclared" },
          children: ["ok"],
          visibleWhen: { ref: "$state.open", eq: true },
        },
        { id: "ok", type: "action.button", props: { label: "OK" } },
      ],
      // Do not declare the close event.
      events: [],
    });
    const onEvent = vi.fn();
    renderSpec(spec, onEvent);
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.keyDown(dialogEl(), { key: "Escape" });
    // An undeclared close is not forwarded (governance), and the dialog does not close.
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe("overlay.toast (React): auto-dismiss timer and non-focus-stealing", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function toastSpec(props: Record<string, unknown>): UISpec {
    return makeSpec({
      state: { toastOpen: true },
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["anchor", "t"] },
        { id: "anchor", type: "action.button", props: { label: "Anchor" } },
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

  it("error tone is role=alert, and does not steal focus from the anchor element", () => {
    renderSpec(toastSpec({ message: "Failed", tone: "error" }));
    const anchor = screen.getByText("Anchor");
    anchor.focus();
    // Even on re-render, the toast does not steal focus.
    expect(document.activeElement).toBe(anchor);
    expect(screen.getByRole("alert").textContent).toContain("Failed");
  });

  it("info/success tone is role=status", () => {
    renderSpec(toastSpec({ message: "Saved", tone: "success" }));
    expect(screen.getByRole("status").textContent).toContain("Saved");
  });

  it("the × button fires dismiss to close it manually", () => {
    renderSpec(toastSpec({ message: "Saved" }));
    expect(screen.queryByRole("status")).not.toBeNull();
    // Clicking the × button (aria-label="Close") fires dismiss → state.set (toastOpen=false) → hidden.
    fireEvent.click(screen.getByLabelText("Close"));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("after durationMs elapses, dismiss (state.set) fires → the toast disappears", () => {
    vi.useFakeTimers();
    renderSpec(toastSpec({ message: "Saved", tone: "success", durationMs: 3000 }));
    expect(screen.queryByRole("status")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("when durationMs is omitted it does not disappear (no timer is set)", () => {
    vi.useFakeTimers();
    renderSpec(toastSpec({ message: "Close manually" }));
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(screen.queryByRole("status")).not.toBeNull();
  });

  it("clears the timer on unmount (closing before dismissal fires no late callback)", () => {
    vi.useFakeTimers();
    const { unmount } = renderSpec(toastSpec({ message: "Saved", durationMs: 5000 }));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    // Cleanup calls clearTimeout so no pending timer remains.
    expect(vi.getTimerCount()).toBe(0);
  });
});

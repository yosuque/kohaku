import { PARTS_STATE_CSS } from "@kohaku-ui/renderer-core";
import { describe, expect, it, vi } from "vitest";
import type { KohakuSurface } from "../src/index.js";
import { buildSpec, byKohaku, mount, root } from "./util.js";

describe("shadow root state stylesheet", () => {
  it("the shadow root carries the theme-neutral L1 state stylesheet", () => {
    const surface = document.createElement("kohaku-surface") as KohakuSurface;
    document.body.appendChild(surface);
    const style = surface.shadowRoot!.querySelector("style")!;
    expect(style.textContent).toContain(":host{display:block}");
    expect(style.textContent).toContain(PARTS_STATE_CSS);
  });
});

describe("per-node error isolation", () => {
  it("isolates one part's render exception, falls back (role=note) + onNodeError, siblings survive", () => {
    // Passing a non-array to presentForm's fields makes buildDefaults' for..of throw a synchronous exception.
    const spec = buildSpec({
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["bad", "good"] },
        { id: "bad", type: "presentForm", props: { action: "x", fields: 5 } },
        { id: "good", type: "text.heading", props: { text: "Survived" } },
      ],
    });
    const onNodeError = vi.fn();
    const surface = mount(spec, { onNodeError });

    const notes = root(surface).querySelectorAll('[role="note"]');
    expect(notes.length).toBe(1);
    expect(notes[0]!.textContent).toContain("Failed to render component (presentForm / bad)");
    expect(onNodeError).toHaveBeenCalledWith(
      expect.objectContaining({ componentId: "bad", componentType: "presentForm" }),
    );
    // Siblings survive
    expect(byKohaku(surface, "good")!.textContent).toBe("Survived");
  });
});

describe("inline reflection of theme tokens", () => {
  it("ui.loading reflects color.muted / color.border into inline style and SVG stroke", () => {
    const spec = buildSpec({
      components: [{ id: "root", type: "ui.loading", props: { label: "…" } }],
    });
    const surface = mount(spec, { theme: { "color.muted": "#111827", "color.border": "#abcdef" } });
    const el = byKohaku(surface, "root")!;
    // color is inline-expanded (rgb normalized)
    expect(el.style.color).toBe("rgb(17, 24, 39)");
    // The SVG stroke uses token-resolved values (circle=border, path=muted)
    const circle = el.querySelector("circle")!;
    const path = el.querySelector("path")!;
    expect(circle.getAttribute("stroke")).toBe("#abcdef");
    expect(path.getAttribute("stroke")).toBe("#111827");
  });

  it(":host lays down CSS variables (--kohaku-color-*) to provide an external theme override point", () => {
    const spec = buildSpec({
      components: [{ id: "root", type: "text.heading", props: { text: "x" } }],
    });
    const surface = mount(spec, { theme: { "color.primary": "#4f46e5" } });
    expect(surface.style.getPropertyValue("--kohaku-color-primary")).toBe("#4f46e5");
  });
});

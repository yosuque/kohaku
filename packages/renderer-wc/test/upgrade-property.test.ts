import { describe, expect, it, vi } from "vitest";
import type { KohakuSurface } from "../src/index.js";
import { buildSpec, mount, root } from "./util.js";

// The plan's item for this file: a "construct before define, assign properties, then define" case,
// exercising kohaku-surface.ts's #upgradeProperty (the standard Custom Elements "upgrade property"
// pattern). Kept as a standalone file rather than in test/parity/ (owned by another agent this wave).
//
// The real-world gotcha: `const el = document.createElement("my-el"); el.foo = "bar";` assigned BEFORE
// `customElements.define("my-el", MyEl)` sets a plain own data property on the not-yet-upgraded element
// (its class accessors do not exist yet). When the element is later upgraded (its prototype swapped to
// MyEl.prototype), that own property permanently shadows the class's `foo` getter/setter — `el.foo = ...`
// from then on never reaches the setter again, unless the class explicitly re-applies it once at upgrade
// time (typically in connectedCallback, since upgrade + connection happen together for an element already
// in the document when define() runs).
//
// util.ts calls defineKohakuSurface() once at module load, so <kohaku-surface> is always already defined
// by the time any test in this suite runs — there is no way to reproduce the browser's own upgrade timing
// here. Object.defineProperty is used instead to install the exact same *shape* of own data property that
// a real pre-upgrade assignment would leave behind (bypassing the class's accessor at the instance level),
// which is the only thing #upgradeProperty actually has to detect and repair.
describe("KohakuSurface: #upgradeProperty (construct-before-define pattern)", () => {
  it("an own-property assigned before upgrade is re-applied through the real setter in connectedCallback", () => {
    const onEvent = vi.fn();
    const spec = buildSpec({
      components: [{ id: "root", type: "action.button", props: { label: "Go" } }],
      events: [{ on: "root.press", emit: "intent.replace", payload: {} }],
    });

    const surface = document.createElement("kohaku-surface") as KohakuSurface;
    // Simulate the construct-before-define gotcha for both a batch property (context, carrying onEvent)
    // and spec itself.
    Object.defineProperty(surface, "context", { value: { onEvent }, configurable: true, writable: true });
    Object.defineProperty(surface, "spec", { value: spec, configurable: true, writable: true });
    expect(Object.hasOwn(surface, "context")).toBe(true);
    expect(Object.hasOwn(surface, "spec")).toBe(true);
    // Not connected yet, so connectedCallback (and therefore #upgradeProperty) has not run: nothing is
    // rendered, and the values are still plain own-properties, not live through the class's accessors.
    expect(root(surface).firstElementChild).toBeNull();

    document.body.appendChild(surface); // connectedCallback fires here -> #upgradeProperty repairs both.

    // The own-properties are gone (delete-then-reassign through the real accessor, per the standard pattern).
    expect(Object.hasOwn(surface, "context")).toBe(false);
    expect(Object.hasOwn(surface, "spec")).toBe(false);
    // The setters ran for real (not left inert): the tree was actually built...
    const button = root(surface).querySelector("button");
    expect(button).not.toBeNull();
    // ...using the exact context (including onEvent) that was assigned before upgrade.
    button!.click();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ componentId: "root", on: "root.press" }));

    document.body.removeChild(surface);
  });

  it("is a no-op for an element created normally (no own-property to repair)", () => {
    // mount() goes through document.createElement + context/spec setters as usual (no pre-upgrade own
    // properties involved) — connectedCallback's #upgradeProperty loop must not disturb this normal path.
    const surface = mount(
      buildSpec({ components: [{ id: "root", type: "text.heading", props: { text: "hi" } }] }),
      {},
    );
    expect(root(surface).firstElementChild).not.toBeNull();
    for (const prop of [
      "spec",
      "context",
      "binding",
      "theme",
      "locale",
      "messages",
      "onEvent",
      "onNodeError",
      "onActionResult",
      "sandbox",
    ]) {
      expect(Object.hasOwn(surface, prop)).toBe(false);
    }
  });
});

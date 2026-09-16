import type { MountSandboxOptions, SandboxHandle, SandboxState } from "@kohaku-ui/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KohakuSurface } from "../src/index.js";
import { buildSpec, byKohaku, mount, root, tick } from "./util.js";

// Since a real iframe/handshake does not run to completion in jsdom, mock mountSandbox (same style as
// phase3-sandbox.test.ts) so disconnectedCallback's sandbox-destroy wiring can be observed directly.
const { mountCalls, destroyed } = vi.hoisted(() => ({
  mountCalls: [] as MountSandboxOptions[],
  destroyed: [] as number[],
}));

vi.mock("@kohaku-ui/sandbox", () => ({
  mountSandbox: (options: MountSandboxOptions): SandboxHandle => {
    const index = mountCalls.length;
    mountCalls.push(options);
    return {
      state: "loading" as SandboxState,
      onStateChange: (listener) => listener("loading"),
      updateProps: () => {},
      invalidate: () => {},
      destroy: () => destroyed.push(index),
    };
  },
}));

afterEach(() => {
  document.body.replaceChildren();
  mountCalls.length = 0;
  destroyed.length = 0;
});

const SPEC = buildSpec({
  components: [{ id: "root", type: "text.heading", props: { text: "hi" } }],
});

/** Sets one individual context property on the surface (typed setters, indexed generically for the table test). */
function setProp(surface: KohakuSurface, name: string, value: unknown): void {
  (surface as unknown as Record<string, unknown>)[name] = value;
}

const bindingA = {
  resolve: async () => ({ columns: [], rows: [] }),
  invokeAction: async () => ({ result: null }),
};
const bindingB = {
  resolve: async () => ({ columns: [], rows: [] }),
  invokeAction: async () => ({ result: null }),
};

// [setterName, value1, value2] — value1 !== value2 by reference (or, for primitives, by value).
// These are the REBUILD_KEYS setters (kohaku-surface.ts): a change is baked into the mounted RenderRuntime
// and requires tearing down + rebuilding the whole tree.
const REBUILD_SETTER_CASES: [string, unknown, unknown][] = [
  ["binding", bindingA, bindingB],
  ["theme", { colors: { primary: "#111" } }, { colors: { primary: "#222" } }],
  ["locale", "en-US", "ja-JP"],
  ["messages", { loading: "Loading A" }, { loading: "Loading B" }],
  [
    "sandbox",
    { bridge: { resolveBinding: async () => ({}), onEvent: () => {}, onTelemetry: () => {} } },
    { bridge: { resolveBinding: async () => ({}), onEvent: () => {}, onTelemetry: () => {} } },
  ],
];

// onEvent/onNodeError/onActionResult are read live from #context at call time (kohaku-surface.ts's
// REBUILD_KEYS deliberately excludes them) — changing one of these must NOT rebuild the mounted tree.
const LIVE_SETTER_CASES: [string, unknown, unknown][] = [
  ["onEvent", () => {}, () => {}],
  ["onNodeError", () => {}, () => {}],
  ["onActionResult", () => {}, () => {}],
];

const ALL_SETTER_CASES = [...REBUILD_SETTER_CASES, ...LIVE_SETTER_CASES];

describe("KohakuSurface individual context setters", () => {
  it.each(REBUILD_SETTER_CASES)(
    "%s: a changed value rebuilds the tree (new root child identity)",
    (name, v1, v2) => {
      const surface = mount(SPEC, {});
      setProp(surface, name, v1);
      const firstChild = root(surface).firstElementChild;
      expect(firstChild).not.toBeNull();

      setProp(surface, name, v2);
      const secondChild = root(surface).firstElementChild;
      expect(secondChild).not.toBeNull();
      expect(secondChild).not.toBe(firstChild);
    },
  );

  it.each(LIVE_SETTER_CASES)(
    "%s: a changed value does NOT rebuild the tree (read live at call time instead)",
    (name, v1, v2) => {
      const surface = mount(SPEC, {});
      setProp(surface, name, v1);
      const firstChild = root(surface).firstElementChild;
      expect(firstChild).not.toBeNull();

      setProp(surface, name, v2);
      const secondChild = root(surface).firstElementChild;
      expect(secondChild).toBe(firstChild);
    },
  );

  it.each(ALL_SETTER_CASES)(
    "%s: re-assigning the same value does not rebuild (identity unchanged)",
    (name, v1) => {
      const surface = mount(SPEC, {});
      setProp(surface, name, v1);
      const firstChild = root(surface).firstElementChild;
      expect(firstChild).not.toBeNull();

      setProp(surface, name, v1);
      const secondChild = root(surface).firstElementChild;
      expect(secondChild).toBe(firstChild);
    },
  );

  it.each(ALL_SETTER_CASES)(
    "%s: setting it before spec is assigned does not render anything (no throw)",
    (name, v1) => {
      const surface = document.createElement("kohaku-surface") as KohakuSurface;
      document.body.appendChild(surface);
      expect(() => setProp(surface, name, v1)).not.toThrow();
      expect(root(surface).children.length).toBe(0);
    },
  );
});

describe("KohakuSurface: onActionResult / onNodeError stay live across a no-rebuild reassignment", () => {
  it("onActionResult: reassigning it post-hoc (no rebuild) still reaches the new callback on the next action", async () => {
    let version = "v1";
    const binding = {
      async resolve() {
        return { columns: [], rows: [{ note: version }], dataVersion: version };
      },
      async invokeAction() {
        version = "v2";
        return { result: { ok: true } };
      },
    };
    const spec = buildSpec({
      components: [
        {
          id: "root",
          type: "presentForm",
          props: { action: "annotate", fields: [{ name: "note", type: "text", label: "Note" }] },
        },
      ],
      events: [{ on: "root.submit", emit: "action.invoke", payload: { note: "$value.note" } }],
    });
    const spy1 = vi.fn();
    const surface = mount(spec, { binding, onActionResult: spy1 });
    const form = byKohaku(surface, "root") as HTMLFormElement;

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    expect(spy1).toHaveBeenCalledTimes(1);

    // Reassign post-hoc: per REBUILD_KEYS this does not rebuild the tree (same form element identity).
    const spy2 = vi.fn();
    const formBefore = form;
    surface.onActionResult = spy2;
    expect(byKohaku(surface, "root")).toBe(formBefore);

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    expect(spy1).toHaveBeenCalledTimes(1); // unchanged: the old callback is no longer reached
    expect(spy2).toHaveBeenCalledTimes(1);
  });

  it("onNodeError: reassigning it post-hoc (no rebuild) still reaches the new callback on the next render exception", async () => {
    // A visibleWhen subtree is re-evaluated on every $state change by mountReactiveVisible, which calls the
    // same `rt` built at the last #render — entirely independent of KohakuSurface's own #render/#patchContext.
    // This is what actually proves "read live at call time": the mounted tree is never rebuilt between the
    // two triggers below (the "good" sibling's identity stays the same throughout).
    const spec = buildSpec({
      state: { show: false },
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["show", "hide", "bad", "good"] },
        { id: "show", type: "action.button", props: { label: "Show" } },
        { id: "hide", type: "action.button", props: { label: "Hide" } },
        {
          id: "bad",
          // Passing a non-array to presentForm's fields makes buildDefaults' for..of throw synchronously
          // (same trigger as isolation-theme.test.ts's per-node error isolation test).
          type: "presentForm",
          props: { action: "x", fields: 5 },
          visibleWhen: { ref: "$state.show", eq: true },
        },
        { id: "good", type: "text.heading", props: { text: "Survived" } },
      ],
      events: [
        { on: "show.press", emit: "state.set", payload: { key: "show", value: true } },
        { on: "hide.press", emit: "state.set", payload: { key: "show", value: false } },
      ],
    });
    const spy1 = vi.fn();
    const surface = mount(spec, { onNodeError: spy1 });
    const goodBefore = byKohaku(surface, "good");
    const showBtn = byKohaku(surface, "show") as HTMLButtonElement;
    const hideBtn = byKohaku(surface, "hide") as HTMLButtonElement;

    showBtn.click();
    await tick();
    expect(spy1).toHaveBeenCalledTimes(1);

    // Reassign post-hoc: per REBUILD_KEYS this does not rebuild the tree (same "good" sibling identity).
    const spy2 = vi.fn();
    surface.onNodeError = spy2;
    expect(byKohaku(surface, "good")).toBe(goodBefore);

    hideBtn.click();
    await tick();
    showBtn.click();
    await tick();

    expect(spy1).toHaveBeenCalledTimes(1); // unchanged: the old callback is no longer reached
    expect(spy2).toHaveBeenCalledTimes(1);
  });
});

describe("KohakuSurface.disconnectedCallback", () => {
  it("destroys the mounted sandbox bridge when the surface is removed from the DOM", () => {
    const SHA = "a".repeat(64);
    const HTML = "<html><body>x</body></html>";
    const bridge = {
      resolveBinding: async () => ({ columns: [], rows: [], dataVersion: "v1" }),
      onEvent: () => {},
      onTelemetry: () => {},
    };
    const spec = buildSpec({
      components: [{ id: "root", type: "sandbox.html", props: {}, artifact: { inline: HTML, sha256: SHA } }],
    });
    const surface = mount(spec, { sandbox: { bridge } });
    expect(mountCalls).toHaveLength(1);
    expect(destroyed).toHaveLength(0);

    surface.remove();

    expect(destroyed).toHaveLength(1);
  });
});

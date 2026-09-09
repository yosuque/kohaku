import type { MountSandboxOptions, SandboxHandle, SandboxState } from "@kohaku-ui/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KohakuSurface } from "../src/index.js";
import { buildSpec, mount, root } from "./util.js";

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
const SETTER_CASES: [string, unknown, unknown][] = [
  ["binding", bindingA, bindingB],
  ["theme", { colors: { primary: "#111" } }, { colors: { primary: "#222" } }],
  ["locale", "en-US", "ja-JP"],
  ["messages", { loading: "Loading A" }, { loading: "Loading B" }],
  ["onEvent", () => {}, () => {}],
  ["onNodeError", () => {}, () => {}],
  ["onActionResult", () => {}, () => {}],
  [
    "sandbox",
    { bridge: { resolveBinding: async () => ({}), onEvent: () => {}, onTelemetry: () => {} } },
    { bridge: { resolveBinding: async () => ({}), onEvent: () => {}, onTelemetry: () => {} } },
  ],
];

describe("KohakuSurface individual context setters", () => {
  it.each(SETTER_CASES)("%s: a changed value rebuilds the tree (new root child identity)", (name, v1, v2) => {
    const surface = mount(SPEC, {});
    setProp(surface, name, v1);
    const firstChild = root(surface).firstElementChild;
    expect(firstChild).not.toBeNull();

    setProp(surface, name, v2);
    const secondChild = root(surface).firstElementChild;
    expect(secondChild).not.toBeNull();
    expect(secondChild).not.toBe(firstChild);
  });

  it.each(SETTER_CASES)(
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

  it.each(SETTER_CASES)(
    "%s: setting it before spec is assigned does not render anything (no throw)",
    (name, v1) => {
      const surface = document.createElement("kohaku-surface") as KohakuSurface;
      document.body.appendChild(surface);
      expect(() => setProp(surface, name, v1)).not.toThrow();
      expect(root(surface).children.length).toBe(0);
    },
  );
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

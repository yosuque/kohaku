import type { ActionResult, BindingClient } from "@kohaku-ui/data-binding";
import type { MountSandboxOptions, SandboxHandle, SandboxState } from "@kohaku-ui/sandbox";
import { describe, expect, it, vi } from "vitest";
import { buildSpec, byKohaku, mount, tick } from "./util.js";

// Since a real iframe and handshake do not run to completion in jsdom, mock mountSandbox and
// verify only the WC wrapper's wiring (options / status display / invalidate bridging) (the style of the sandbox-side react.test).
const { mountCalls, invalidated, destroyed } = vi.hoisted(() => ({
  mountCalls: [] as MountSandboxOptions[],
  invalidated: [] as string[],
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
      invalidate: (ref: string) => invalidated.push(ref),
      destroy: () => destroyed.push(index),
    };
  },
}));

const SHA = "a".repeat(64);
const HTML = "<html><body>x</body></html>";
const bridge = {
  resolveBinding: async () => ({ columns: [], rows: [], dataVersion: "v1" }),
  onEvent: () => {},
  onTelemetry: () => {},
};

describe("Phase 3: L2 sandbox", () => {
  it("without a bridge injected, emits a placeholder requesting injection", () => {
    const spec = buildSpec({
      components: [{ id: "root", type: "sandbox.html", props: {}, artifact: { inline: HTML, sha256: SHA } }],
    });
    const surface = mount(spec, {});
    const wrapper = byKohaku(surface, "root")!;
    expect(wrapper.textContent).toContain("requires injecting the sandbox bridge");
    expect(mountCalls).toHaveLength(0);
  });

  it("with a bridge injected, calls mountSandbox with allowedEvents / allowedRef / initialProps", () => {
    mountCalls.length = 0;
    const REF = "query://sales/detail";
    const spec = buildSpec({
      dataVersion: "v1",
      refVersions: { [REF]: "v1" },
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["sb"] },
        {
          id: "sb",
          type: "sandbox.html",
          props: { title: "custom" },
          artifact: { inline: HTML, sha256: SHA },
          data: { $ref: REF },
        },
      ],
      events: [{ on: "sb.pick", emit: "intent.replace", payload: {} }],
    });
    const surface = mount(spec, { sandbox: { bridge } });
    const wrapper = byKohaku(surface, "sb")!;
    // L2 badge + the starting-up notification
    expect(wrapper.textContent).toContain("L2 SANDBOXED");
    expect(wrapper.textContent).toContain("Starting the sandbox");

    expect(mountCalls).toHaveLength(1);
    const opts = mountCalls[0]!;
    expect(opts.componentId).toBe("sb");
    expect(opts.allowedRef).toBe(REF);
    expect(opts.allowedEvents).toEqual(["pick"]);
    expect(opts.initialProps).toEqual({ title: "custom" });
    expect(opts.artifact).toEqual({ inline: HTML, sha256: SHA });
  });

  it("passes context.theme to mountSandbox's theme (token injection path into the sandbox iframe)", () => {
    mountCalls.length = 0;
    const theme = { "color.background": "#0f1115" };
    const spec = buildSpec({
      components: [{ id: "root", type: "sandbox.html", props: {}, artifact: { inline: HTML, sha256: SHA } }],
    });
    mount(spec, { sandbox: { bridge }, theme });
    expect(mountCalls).toHaveLength(1);
    // The same handoff as renderer-react (SandboxFrame's theme prop) = both renderers inject the same set of tokens
    expect(mountCalls[0]!.theme).toEqual(theme);
  });

  it("with no theme specified, passes an empty theme (mount merges into the default light theme)", () => {
    mountCalls.length = 0;
    const spec = buildSpec({
      components: [{ id: "root", type: "sandbox.html", props: {}, artifact: { inline: HTML, sha256: SHA } }],
    });
    mount(spec, { sandbox: { bridge } });
    expect(mountCalls[0]!.theme).toEqual({});
  });

  it("subscribes to write invalidations (invalidates) and bridges them to handle.invalidate", async () => {
    mountCalls.length = 0;
    invalidated.length = 0;
    const REF = "query://sales/detail";
    const binding: BindingClient = {
      async resolve() {
        return { columns: [], rows: [], dataVersion: "v1" };
      },
      async invokeAction(): Promise<ActionResult> {
        return { result: null, invalidates: [REF] };
      },
    };
    const spec = buildSpec({
      dataVersion: "v1",
      refVersions: { [REF]: "v1" },
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["sb", "btn"] },
        {
          id: "sb",
          type: "sandbox.html",
          props: {},
          artifact: { inline: HTML, sha256: SHA },
          data: { $ref: REF },
        },
        { id: "btn", type: "action.button", props: { label: "Update", action: "touch" } },
      ],
      events: [{ on: "btn.press", emit: "action.invoke", payload: { action: "touch" } }],
    });
    const surface = mount(spec, { binding, sandbox: { bridge } });
    (byKohaku(surface, "btn") as HTMLButtonElement).click();
    await tick();
    // The action's invalidates reach the sandbox's invalidate via the bus
    expect(invalidated).toEqual([REF]);
  });
});

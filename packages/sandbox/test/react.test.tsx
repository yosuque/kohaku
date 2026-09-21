import type { ComponentNode, UISpec } from "@kohaku-ui/spec-core";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxFrame } from "../src/react.js";
import type { MountSandboxOptions, SandboxHandle } from "../src/types.js";

// mountSandbox involves a real iframe and handshake and does not run to completion in jsdom, so we mock it to
// verify only SandboxFrame's re-mount wiring (when to rebuild / destroy).
const { mountCalls, destroyed } = vi.hoisted(() => ({
  mountCalls: [] as MountSandboxOptions[],
  destroyed: [] as number[],
}));

vi.mock("../src/mount.js", () => ({
  mountSandbox: (options: MountSandboxOptions): SandboxHandle => {
    const index = mountCalls.length;
    mountCalls.push(options);
    return {
      state: "loading",
      onStateChange: () => {},
      updateProps: () => {},
      invalidate: () => {},
      destroy: () => destroyed.push(index),
    };
  },
}));

const SHA = "sha256:" + "a".repeat(64);
const HTML = "<html><body>x</body></html>";

const bridge = {
  resolveBinding: async () => ({ columns: [], rows: [], dataVersion: "v1" }),
  onEvent: () => {},
  onTelemetry: () => {},
};

const spec = { events: [] } as unknown as UISpec;

function node(ref: string): ComponentNode {
  return {
    id: "sb1",
    type: "sandbox.html",
    props: {},
    artifact: { inline: HTML, sha256: SHA },
    data: { $ref: ref },
  } as unknown as ComponentNode;
}

beforeEach(() => {
  mountCalls.length = 0;
  destroyed.length = 0;
});

afterEach(() => {
  cleanup();
});

/** Renders SandboxFrame with the standard node/spec/bridge, overridable per test. */
function renderFrame(overrides: Partial<Parameters<typeof SandboxFrame>[0]> = {}) {
  return render(<SandboxFrame node={node("query://a")} spec={spec} bridge={bridge} {...overrides} />);
}

describe("SandboxFrame re-mount conditions", () => {
  it("even with the same sha256, a changed $ref re-mounts and destroys the old iframe", () => {
    const { rerender } = render(<SandboxFrame node={node("query://a")} spec={spec} bridge={bridge} />);
    expect(mountCalls).toHaveLength(1);
    expect(mountCalls[0]!.allowedRef).toBe("query://a");

    // Keep sha256 and swap only $ref. The old implementation (dependency [sha256] only) would not rebuild and the old
    // allowedRef would remain, but the implementation that includes node.id / $ref as dependencies re-mounts.
    rerender(<SandboxFrame node={node("query://b")} spec={spec} bridge={bridge} />);
    expect(destroyed).toContain(0);
    expect(mountCalls).toHaveLength(2);
    expect(mountCalls[1]!.allowedRef).toBe("query://b");
  });

  it("when node / $ref are unchanged, does not re-mount (avoids unnecessary rebuilds)", () => {
    const stable = node("query://a");
    const { rerender } = render(<SandboxFrame node={stable} spec={spec} bridge={bridge} />);
    expect(mountCalls).toHaveLength(1);

    // Re-rendering with the same node.id / sha256 / $ref keeps mount at just once.
    rerender(<SandboxFrame node={node("query://a")} spec={spec} bridge={bridge} />);
    expect(mountCalls).toHaveLength(1);
    expect(destroyed).toHaveLength(0);
  });

  it("re-mounts the iframe when kitCss changes and passes it through", () => {
    const { rerender } = render(
      <SandboxFrame node={node("query://a")} spec={spec} bridge={bridge} kitCss=".a{}" />,
    );
    expect(mountCalls).toHaveLength(1);
    expect(mountCalls[0]!.kitCss).toBe(".a{}");

    rerender(<SandboxFrame node={node("query://a")} spec={spec} bridge={bridge} kitCss=".b{}" />);
    expect(destroyed).toContain(0);
    expect(mountCalls).toHaveLength(2);
    expect(mountCalls[1]!.kitCss).toBe(".b{}");
  });
});

describe("SandboxFrame chrome (kitCss / badge threading)", () => {
  it("kitCss='' reaches mountSandbox as '', not undefined (explicit opt-out is preserved)", () => {
    renderFrame({ kitCss: "" });
    expect(mountCalls).toHaveLength(1);
    expect(mountCalls[0]!.kitCss).toBe("");
    expect(mountCalls[0]!.kitCss).not.toBeUndefined();
  });

  it("badge='hidden' omits the L2 SANDBOXED badge row", () => {
    const { container } = renderFrame({ badge: "hidden" });
    expect(container.textContent).not.toContain("L2 SANDBOXED");
  });

  it("badge left unset (default) shows the L2 SANDBOXED badge row", () => {
    const { container } = renderFrame();
    expect(container.textContent).toContain("L2 SANDBOXED");
  });
});

// Task 3 (M-2): the `kit` prop's resolver form, and the rollback use case it exists for — a host telling
// an artifact composed under an old design kit apart from one composed under the current kit, on a per-node
// basis, purely from spec.provenance (no side channel needed).
describe("SandboxFrame kit (DesignKitStylesheet / resolver / rollback)", () => {
  const V1_CSS = ".k-card{border:1px solid gray}";
  const V2_CSS = ".k-card{border:2px solid black}";

  function specWithKit(kit?: { id: string; version: string }): UISpec {
    return {
      events: [],
      provenance: { tier: "L1", composedBy: "test", cache: "miss", ...(kit != null ? { kit } : {}) },
    } as unknown as UISpec;
  }

  it("a DesignKitStylesheet object value is passed through to mountSandbox's kit as-is", () => {
    renderFrame({ kit: { id: "kohaku", version: "2", css: V2_CSS } });
    expect(mountCalls).toHaveLength(1);
    expect(mountCalls[0]!.kit).toEqual({ id: "kohaku", version: "2", css: V2_CSS });
  });

  it("a bare string value behaves like kitCss (passed through as kit, no version identity)", () => {
    renderFrame({ kit: ".acme{}" });
    expect(mountCalls[0]!.kit).toBe(".acme{}");
  });

  it("spec.provenance.kit is threaded through to mountSandbox's provenanceKit", () => {
    renderFrame({ spec: specWithKit({ id: "kohaku", version: "1" }) });
    expect(mountCalls[0]!.provenanceKit).toEqual({ id: "kohaku", version: "1" });
  });

  it("no provenanceKit is passed when the Spec carries no provenance.kit", () => {
    renderFrame({ spec: specWithKit() });
    expect(mountCalls[0]!.provenanceKit).toBeUndefined();
  });

  it("rollback: a resolver picks the kit matching each node's own provenance.kit, so an old artifact keeps its old styling after the surface-wide default moves on", () => {
    const oldSpec = specWithKit({ id: "kohaku", version: "1" });
    const newSpec = specWithKit({ id: "kohaku", version: "2" });
    const resolver = (_n: ComponentNode, spec: UISpec): { id: string; version: string; css: string } =>
      spec.provenance.kit?.version === "1"
        ? { id: "kohaku", version: "1", css: V1_CSS }
        : { id: "kohaku", version: "2", css: V2_CSS };

    const { rerender } = render(
      <SandboxFrame node={node("query://a")} spec={oldSpec} bridge={bridge} kit={resolver} />,
    );
    expect(mountCalls).toHaveLength(1);
    expect(mountCalls[0]!.kit).toEqual({ id: "kohaku", version: "1", css: V1_CSS });
    expect(mountCalls[0]!.provenanceKit).toEqual({ id: "kohaku", version: "1" });

    // A second, independently-rendered old-provenance node still resolves to the old kit — the resolver is
    // driven by each Spec's own provenance, not by "whatever the surface last rendered".
    render(<SandboxFrame node={node("query://c")} spec={oldSpec} bridge={bridge} kit={resolver} />);
    expect(mountCalls[1]!.kit).toEqual({ id: "kohaku", version: "1", css: V1_CSS });

    // Re-rendering the first node with a Spec composed under the new kit re-mounts and resolves to v2 —
    // the resolver reacts to a change in its own inputs (spec.provenance.kit), not to global surface state.
    rerender(<SandboxFrame node={node("query://a")} spec={newSpec} bridge={bridge} kit={resolver} />);
    expect(destroyed).toContain(0);
    const last = mountCalls[mountCalls.length - 1]!;
    expect(last.kit).toEqual({ id: "kohaku", version: "2", css: V2_CSS });
    expect(last.provenanceKit).toEqual({ id: "kohaku", version: "2" });
  });

  it("a resolver returning undefined means 'use the default kit' (kit key omitted, same as an absent kit prop)", () => {
    renderFrame({ kit: () => undefined });
    expect(mountCalls[0]!.kit).toBeUndefined();
  });

  it("a resolver returning '' means 'inject none', threaded through as an explicit empty kit", () => {
    renderFrame({ kit: () => "" });
    expect(mountCalls[0]!.kit).toBe("");
  });
});

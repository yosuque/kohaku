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

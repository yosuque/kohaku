import { sha256Hex } from "@kohaku-ui/spec-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountSandbox } from "../src/mount.js";
import { PROTOCOL } from "../src/protocol.js";
import type { SandboxArtifact, SandboxBridge, SandboxState, SandboxTelemetryEvent } from "../src/types.js";

// Uses document / window in the jsdom environment (environment: "jsdom" in vitest.config.ts).

const bridge: SandboxBridge = {
  resolveBinding: async () => ({}),
  onEvent: () => {},
  onTelemetry: () => {},
};

describe("mountSandbox state replay", () => {
  it("replays a synchronously settled error (maxHtmlBytes exceeded) to a listener registered afterward", () => {
    // An inline exceeding the default maxHtmlBytes (256KiB). Reproduces the path where a synchronous throw before
    // verifyArtifact (the first await) -> setState("error") is settled before mountSandbox returns.
    const artifact: SandboxArtifact = {
      inline: "x".repeat(256 * 1024 + 1),
      sha256: "sha256:" + "0".repeat(64),
    };
    const handle = mountSandbox({
      container: document.createElement("div"),
      componentId: "sb-oversized",
      allowedEvents: [],
      artifact,
      bridge,
    });

    // At the point mountSandbox returns, state is already error (the synchronous path).
    expect(handle.state).toBe("error");

    // Even if onStateChange is registered afterward, the current state and most recent detail are replayed immediately.
    const received: Array<{ state: SandboxState; detail: string | undefined }> = [];
    handle.onStateChange((state, detail) => received.push({ state, detail }));
    expect(received).toHaveLength(1);
    expect(received[0]!.state).toBe("error");
    expect(received[0]!.detail).toContain("maxHtmlBytes");
  });

  it("subsequent state transitions reach subscribers as usual, following the replay", () => {
    const artifact: SandboxArtifact = {
      inline: "x".repeat(256 * 1024 + 1),
      sha256: "sha256:" + "0".repeat(64),
    };
    const handle = mountSandbox({
      container: document.createElement("div"),
      componentId: "sb-oversized-2",
      allowedEvents: [],
      artifact,
      bridge,
    });

    const states: SandboxState[] = [];
    handle.onStateChange((state) => states.push(state));
    // error on the initial replay. Then calling destroy() delivers destroyed right after.
    handle.destroy();
    expect(states).toEqual(["error", "destroyed"]);
  });
});

describe("mountSandbox destroy race (zombie iframe prevention)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("if destroyed during the verify await, does not append an iframe", async () => {
    const html = "<!DOCTYPE html><html><body>widget</body></html>";
    const artifact: SandboxArtifact = { inline: html, sha256: await sha256Hex(html) };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const handle = mountSandbox({
      container,
      componentId: "sb-zombie",
      allowedEvents: [],
      artifact,
      bridge,
    });
    // Destroy before the async IIFE (the verifyArtifact await) resumes
    // (React StrictMode's mount -> immediate cleanup -> re-mount, whose cleanup takes this path).
    handle.destroy();

    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector("iframe")).toBeNull();
    expect(handle.state).toBe("destroyed");
  });

  it("a StrictMode-equivalent mount → destroy → re-mount ends with only one iframe", async () => {
    const html = "<!DOCTYPE html><html><body>widget</body></html>";
    const artifact: SandboxArtifact = { inline: html, sha256: await sha256Hex(html) };
    const container = document.createElement("div");
    document.body.appendChild(container);

    const first = mountSandbox({
      container,
      componentId: "sb-strict",
      allowedEvents: [],
      artifact,
      bridge,
    });
    first.destroy();
    const second = mountSandbox({
      container,
      componentId: "sb-strict",
      allowedEvents: [],
      artifact,
      bridge,
    });

    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    expect(second.state).toBe("loading"); // The second one (the surviving side) waits for boot as usual
    second.destroy();
  });
});

describe("mountSandbox theme token injection", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  async function mountAndGetSrcdoc(theme?: Parameters<typeof mountSandbox>[0]["theme"]) {
    const html = "<!DOCTYPE html><html><body>widget</body></html>";
    const artifact: SandboxArtifact = { inline: html, sha256: await sha256Hex(html) };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const handle = mountSandbox({
      container,
      componentId: "sb-theme",
      allowedEvents: [],
      artifact,
      bridge,
      ...(theme != null ? { theme } : {}),
    });
    let iframe: HTMLIFrameElement | null = null;
    for (let i = 0; i < 50 && iframe == null; i++) {
      await new Promise((r) => setTimeout(r, 0));
      iframe = container.querySelector("iframe");
    }
    expect(iframe).not.toBeNull();
    const srcdoc = iframe!.srcdoc;
    handle.destroy();
    return srcdoc;
  }

  it("even without a theme, the default light theme's CSS variables are injected into the srcdoc", async () => {
    const srcdoc = await mountAndGetSrcdoc();
    expect(srcdoc).toContain("<style>:root{");
    // The generated HTML's var(--kohaku-*) references do not fall through to undefined (the default light theme net)
    expect(srcdoc).toContain("--kohaku-color-primary:#4f46e5;");
    expect(srcdoc).toContain("--kohaku-chart-palette-1:");
  });

  it("passing a theme injects the override values (the dark-mode switch path)", async () => {
    const srcdoc = await mountAndGetSrcdoc({ "color.background": "#0f1115" });
    expect(srcdoc).toContain("--kohaku-color-background:#0f1115;");
  });
});

describe("mountSandbox immediate failure on a guest error during boot", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  /**
   * jsdom neither executes the srcdoc nor transfers the MessagePort, so we simulate the guest side:
   * 1. wait until mount creates the iframe, and extract the nonce from the srcdoc
   * 2. dispatch handshake.ready to the parent window with source=iframe.contentWindow
   * 3. capture the MessageChannel that mount creates, and send messages directly from the guest-side port (port2)
   */
  async function mountWithSimulatedHandshake() {
    const channels: MessageChannel[] = [];
    const RealMessageChannel = window.MessageChannel;
    vi.spyOn(window as { MessageChannel: typeof MessageChannel }, "MessageChannel").mockImplementation(
      // Must stay a function expression: this replacement is invoked with `new`.
      function () {
        const ch = new RealMessageChannel();
        channels.push(ch);
        return ch;
      } as unknown as () => MessageChannel,
    );

    const html = "<!DOCTYPE html><html><body>widget</body></html>";
    const artifact: SandboxArtifact = { inline: html, sha256: await sha256Hex(html) };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const states: Array<{ state: SandboxState; detail: string | undefined }> = [];
    const handle = mountSandbox({
      container,
      componentId: "sb-boot-error",
      allowedEvents: [],
      artifact,
      bridge: {
        resolveBinding: async () => ({}),
        onEvent: () => {},
        onTelemetry: () => {},
      },
      policy: { bootTimeoutMs: 60_000 }, // timeout is placed far away since we are verifying immediate failure
    });
    handle.onStateChange((state, detail) => states.push({ state, detail }));

    // Wait for iframe creation across mount's async IIFE (the verifyArtifact await)
    let iframe: HTMLIFrameElement | null = null;
    for (let i = 0; i < 50 && iframe == null; i++) {
      await new Promise((r) => setTimeout(r, 0));
      iframe = container.querySelector("iframe");
    }
    expect(iframe).not.toBeNull();

    const nonce = /<script nonce="([0-9a-f]{32})">/.exec(iframe!.srcdoc)?.[1];
    expect(nonce).toBeDefined();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { kohaku: PROTOCOL, method: "handshake.ready", nonce },
        source: iframe!.contentWindow,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(channels).toHaveLength(1); // onHandshake created the bridge channel

    return { handle, states, guestPort: channels[0]!.port2 };
  }

  it("a guest error (telemetry.report) during loading transitions to error without waiting for the boot timeout", async () => {
    const { handle, states, guestPort } = await mountWithSimulatedHandshake();
    expect(handle.state).toBe("loading");

    guestPort.postMessage({
      method: "telemetry.report",
      params: { kind: "error", detail: "window.kohaku.onReady is not a function" },
    });
    // MessagePort delivery is asynchronous
    for (let i = 0; i < 50 && handle.state === "loading"; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }

    expect(handle.state).toBe("error");
    const last = states[states.length - 1]!;
    expect(last.detail).toContain("onReady is not a function");
    expect(last.detail).not.toContain("boot timeout");
    handle.destroy();
  });

  it("a guest error after ready does not break the displayed UI (no state transition)", async () => {
    const { handle, guestPort } = await mountWithSimulatedHandshake();

    guestPort.postMessage({ method: "ui.ready" });
    for (let i = 0; i < 50 && handle.state !== "ready"; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(handle.state).toBe("ready");

    guestPort.postMessage({
      method: "telemetry.report",
      params: { kind: "error", detail: "minor error after render" },
    });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(handle.state).toBe("ready");
    handle.destroy();
  });
});

describe("mountSandbox navigation guard", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  async function mountForNavigationTest() {
    const html = "<!DOCTYPE html><html><body>widget</body></html>";
    const artifact: SandboxArtifact = { inline: html, sha256: await sha256Hex(html) };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const telemetry: SandboxTelemetryEvent[] = [];
    const handle = mountSandbox({
      container,
      componentId: "sb-nav",
      allowedEvents: [],
      artifact,
      bridge: {
        resolveBinding: async () => ({}),
        onEvent: () => {},
        onTelemetry: (e) => telemetry.push(e),
      },
    });
    let iframe: HTMLIFrameElement | null = null;
    for (let i = 0; i < 50 && iframe == null; i++) {
      await new Promise((r) => setTimeout(r, 0));
      iframe = container.querySelector("iframe");
    }
    expect(iframe).not.toBeNull();
    return { handle, container, iframe: iframe!, telemetry };
  }

  it("the initial load does not trip the guard (state stays loading)", async () => {
    // jsdom ignores srcdoc, loads about:blank and fires "load" synchronously on attach — that already happened
    // by the time mountForNavigationTest's polling loop returns. No further event is dispatched here, so this
    // asserts that the initial (jsdom-triggered) load alone is not misjudged as an illegal navigation.
    const { handle, container } = await mountForNavigationTest();
    expect(handle.state).toBe("loading");
    expect(container.querySelector("iframe")).not.toBeNull();
    handle.destroy();
  });

  it("a second load event tears the iframe down, transitions to error and emits telemetry denied", async () => {
    const { handle, container, iframe, telemetry } = await mountForNavigationTest();
    // Dispatched twice so the test does not depend on whether jsdom already fired the initial load on attach:
    // whichever of the two dispatches is the second load overall trips the guard, and the guard fires onIllegal
    // at most once regardless.
    iframe.dispatchEvent(new Event("load"));
    iframe.dispatchEvent(new Event("load"));
    expect(container.querySelector("iframe")).toBeNull();
    expect(handle.state).toBe("error");
    expect(telemetry.some((t) => t.kind === "denied")).toBe(true);
  });

  it("a load after ready also tears down", async () => {
    const channels: MessageChannel[] = [];
    const RealMessageChannel = window.MessageChannel;
    vi.spyOn(window as { MessageChannel: typeof MessageChannel }, "MessageChannel").mockImplementation(
      // Must stay a function expression: this replacement is invoked with `new`.
      function () {
        const ch = new RealMessageChannel();
        channels.push(ch);
        return ch;
      } as unknown as () => MessageChannel,
    );

    const { handle, container, iframe, telemetry } = await mountForNavigationTest();
    // jsdom already fired the initial load synchronously on attach (see the previous test's comment); no
    // additional load is dispatched here before the handshake.

    const nonce = /<script nonce="([0-9a-f]{32})">/.exec(iframe.srcdoc)?.[1];
    expect(nonce).toBeDefined();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { kohaku: PROTOCOL, method: "handshake.ready", nonce },
        source: iframe.contentWindow,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(channels).toHaveLength(1);
    channels[0]!.port2.postMessage({ method: "ui.ready" });
    for (let i = 0; i < 50 && handle.state !== "ready"; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(handle.state).toBe("ready");

    iframe.dispatchEvent(new Event("load")); // a post-ready navigation
    expect(container.querySelector("iframe")).toBeNull();
    expect(handle.state).toBe("error");
    expect(telemetry.some((t) => t.kind === "denied")).toBe(true);

    vi.restoreAllMocks();
  });
});

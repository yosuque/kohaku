import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ERR_QUOTA_EXCEEDED,
  ERR_REF_NOT_ALLOWED,
  ERR_RPC_TIMEOUT,
  type HostMessage,
  resolvePolicy,
  SandboxHostBridge,
} from "../src/index.js";
import type { SandboxBridge, SandboxPolicy, SandboxTelemetryEvent } from "../src/types.js";

const REF = "query://sales/trend?granularity=month&metric=revenue";

function makePort() {
  const sent: HostMessage[] = [];
  const port = {
    postMessage: (m: HostMessage) => sent.push(m),
    close: vi.fn(),
    onmessage: null as ((ev: { data: unknown }) => void) | null,
  };
  return { port, sent, deliver: (data: unknown) => port.onmessage?.({ data }) };
}

function makeBridge(overrides: Partial<SandboxBridge> = {}) {
  const events: unknown[] = [];
  const telemetry: SandboxTelemetryEvent[] = [];
  const bridge: SandboxBridge = {
    resolveBinding: async () => ({ columns: [], rows: [], dataVersion: "v1" }),
    onEvent: (e) => events.push(e),
    onTelemetry: (e) => telemetry.push(e),
    ...overrides,
  };
  return { bridge, events, telemetry };
}

function setup(
  opts: {
    allowedRef?: string;
    allowedEvents?: string[];
    bridge?: SandboxBridge;
    policy?: SandboxPolicy;
  } = {},
) {
  const { port, sent, deliver } = makePort();
  const made = makeBridge();
  const callbacks = { onReady: vi.fn(), onResize: vi.fn(), onGuestError: vi.fn() };
  new SandboxHostBridge(port, {
    componentId: "sandbox1",
    ...(opts.allowedRef != null ? { allowedRef: opts.allowedRef } : {}),
    allowedEvents: opts.allowedEvents ?? ["select"],
    bridge: opts.bridge ?? made.bridge,
    policy: resolvePolicy({ maxConcurrentFetches: 1, fetchesPerMinute: 2, ...opts.policy }),
    callbacks,
  });
  return { sent, deliver, callbacks, ...made };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("SandboxHostBridge (third layer of the triple defense)", () => {
  it("resolves only binding.fetch that exactly matches a declared $ref", async () => {
    const { sent, deliver } = setup({ allowedRef: REF });
    deliver({ method: "binding.fetch", id: 1, params: { ref: REF } });
    await tick();
    expect(sent[0]).toMatchObject({ method: "rpc.result", id: 1, result: { dataVersion: "v1" } });
  });

  it("an undeclared ref is rejected with -32001 RefNotAllowed and recorded in telemetry", async () => {
    const { sent, deliver, telemetry } = setup({ allowedRef: REF });
    deliver({ method: "binding.fetch", id: 2, params: { ref: "query://sales/records?limit=500" } });
    await tick();
    expect(sent[0]).toMatchObject({
      method: "rpc.result",
      id: 2,
      error: { code: ERR_REF_NOT_ALLOWED },
    });
    expect(telemetry.some((t) => t.kind === "denied")).toBe(true);
  });

  it("with no allowedRef (a node without data), all fetches are rejected", async () => {
    const { sent, deliver } = setup({});
    deliver({ method: "binding.fetch", id: 3, params: { ref: REF } });
    await tick();
    expect(sent[0]).toMatchObject({ method: "rpc.result", error: { code: ERR_REF_NOT_ALLOWED } });
  });

  it("a fetch exceeding the per-minute quota gets -32002", async () => {
    const { sent, deliver } = setup({ allowedRef: REF });
    deliver({ method: "binding.fetch", id: 1, params: { ref: REF } });
    await tick();
    deliver({ method: "binding.fetch", id: 2, params: { ref: REF } });
    await tick();
    deliver({ method: "binding.fetch", id: 3, params: { ref: REF } });
    await tick();
    expect(sent[2]).toMatchObject({ method: "rpc.result", id: 3, error: { code: ERR_QUOTA_EXCEEDED } });
  });

  it("forwards only declared events upstream and drops undeclared ones", async () => {
    const { deliver, events, telemetry } = setup({ allowedEvents: ["select"] });
    deliver({ method: "event.emit", params: { on: "select", payload: { month: "2026-06" } } });
    deliver({ method: "event.emit", params: { on: "hack", payload: {} } });
    await tick();
    expect(events).toEqual([{ componentId: "sandbox1", on: "select", payload: { month: "2026-06" } }]);
    expect(telemetry.some((t) => t.kind === "denied" && t.detail?.includes("hack"))).toBe(true);
  });

  it("ui.ready / ui.resize (clamped) reach the callbacks", async () => {
    const { deliver, callbacks } = setup({});
    deliver({ method: "ui.ready" });
    deliver({ method: "ui.resize", params: { height: 99999 } });
    await tick();
    expect(callbacks.onReady).toHaveBeenCalled();
    expect(callbacks.onResize).toHaveBeenCalledWith(4096);
  });

  it("sending Infinity / NaN to ui.resize does not call onResize", async () => {
    const { deliver, callbacks } = setup({});
    deliver({ method: "ui.resize", params: { height: Infinity } });
    deliver({ method: "ui.resize", params: { height: NaN } });
    await tick();
    expect(callbacks.onResize).not.toHaveBeenCalled();
  });

  it("telemetry detail is truncated to 500 characters", async () => {
    const { deliver, telemetry } = setup({});
    deliver({ method: "telemetry.report", params: { kind: "error", detail: "x".repeat(1000) } });
    await tick();
    const ev = telemetry.find((t) => t.kind === "error");
    expect(ev?.detail).toHaveLength(500);
  });

  it("malformed messages are ignored", async () => {
    const { sent, deliver, telemetry } = setup({});
    deliver({ method: "unknown.method", id: 1 });
    deliver("garbage");
    await tick();
    expect(sent).toHaveLength(0);
    // malformed messages are dropped and return no response. Since denied notifications are throttled to once per window,
    // even two in a row within the same window produce only one notification (so the notification itself does not fuel log bloat).
    expect(telemetry.filter((t) => t.detail === "malformed message")).toHaveLength(1);
  });

  it("telemetry detail collapses control characters (newline, tab, NUL) to spaces before notifying", async () => {
    const { deliver, telemetry } = setup({});
    deliver({ method: "telemetry.report", params: { kind: "error", detail: "a\nb\tc\u0000d\u007fe" } });
    await tick();
    const ev = telemetry.find((t) => t.kind === "error");
    // Newline, tab, NUL, and DEL are all replaced with spaces (suppressing log-line spoofing and terminal-escape injection).
    expect(ev?.detail).toBe("a b c d e");
  });

  it("telemetry.report (kind:error) calls onGuestError with a sanitized detail", async () => {
    const { deliver, callbacks } = setup({});
    deliver({ method: "telemetry.report", params: { kind: "error", detail: "boom\nline2" } });
    await tick();
    // The wiring for mount's "immediate failure during boot". detail is sanitized before being passed, just like telemetry.
    expect(callbacks.onGuestError).toHaveBeenCalledTimes(1);
    expect(callbacks.onGuestError).toHaveBeenCalledWith("boom line2");
  });

  it("telemetry.report kind denied is forwarded as denied and does not call onGuestError", async () => {
    const { deliver, telemetry, callbacks } = setup({});
    deliver({
      method: "telemetry.report",
      params: { kind: "denied", detail: "navigation blocked: http://evil.example" },
    });
    await tick();
    expect(telemetry.some((t) => t.kind === "denied" && t.detail?.includes("navigation blocked"))).toBe(true);
    // A blocked click is not a runtime error and must not flip a still-booting widget into the error state.
    expect(callbacks.onGuestError).not.toHaveBeenCalled();
  });

  it("telemetry.report without detail passes undefined to onGuestError", async () => {
    const { deliver, callbacks } = setup({});
    deliver({ method: "telemetry.report", params: { kind: "error" } });
    await tick();
    expect(callbacks.onGuestError).toHaveBeenCalledTimes(1);
    expect(callbacks.onGuestError).toHaveBeenCalledWith(undefined);
  });

  it("a report dropped due to telemetry quota overrun does not fire onGuestError either", async () => {
    const { deliver, callbacks } = setup({ policy: { telemetryPerMinute: 1 } });
    deliver({ method: "telemetry.report", params: { kind: "error", detail: "1st" } });
    deliver({ method: "telemetry.report", params: { kind: "error", detail: "2nd" } });
    await tick();
    expect(callbacks.onGuestError).toHaveBeenCalledTimes(1);
    expect(callbacks.onGuestError).toHaveBeenCalledWith("1st");
  });

  it("the event.emit payload limit judges multibyte by actual bytes (not .length)", async () => {
    const { deliver, events, telemetry } = setup({
      allowedEvents: ["select"],
      policy: { maxEventPayloadBytes: 30 },
    });
    // The multibyte character used in the payload is 3 bytes in UTF-8. The JSON string's .length is 28 (<= 30) but the
    // actual byte count is 68 (> 30). A .length-based check would let it through, but a byte-based check drops it.
    const payload = { s: "あ".repeat(20) };
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(30);
    deliver({ method: "event.emit", params: { on: "select", payload } });
    await tick();
    expect(events).toHaveLength(0);
    expect(telemetry.some((t) => t.kind === "denied" && t.detail?.includes("payload exceeds"))).toBe(true);
  });
});

describe("SandboxHostBridge quota extensions (event / telemetry / resize) and RPC timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("event.emit drops what exceeds the default 60/min and notifies denied", () => {
    const { deliver, events, telemetry } = setup({ allowedEvents: ["select"] });
    // event.emit handling is synchronous (no await in between), so no tick is needed.
    for (let i = 0; i < 60; i++) {
      deliver({ method: "event.emit", params: { on: "select", payload: { i } } });
    }
    expect(events).toHaveLength(60);
    // The 61st is dropped and a denied telemetry is emitted.
    deliver({ method: "event.emit", params: { on: "select", payload: { i: 60 } } });
    expect(events).toHaveLength(60);
    expect(telemetry.some((t) => t.kind === "denied" && t.detail?.includes("event quota exceeded"))).toBe(
      true,
    );
  });

  it("an event.emit payload exceeding the default 16KiB is dropped and notifies denied", () => {
    const { deliver, events, telemetry } = setup({ allowedEvents: ["select"] });
    const big = "x".repeat(17 * 1024);
    deliver({ method: "event.emit", params: { on: "select", payload: { big } } });
    expect(events).toHaveLength(0);
    expect(telemetry.some((t) => t.kind === "denied" && t.detail?.includes("payload exceeds"))).toBe(true);
  });

  it("telemetry.report overruns are dropped and denied notifications are limited to once per window", () => {
    const { deliver, telemetry } = setup({ policy: { telemetryPerMinute: 3 } });
    for (let i = 0; i < 3; i++) {
      deliver({ method: "telemetry.report", params: { kind: "error", detail: "e" } });
    }
    expect(telemetry.filter((t) => t.kind === "error")).toHaveLength(3);
    // Even with multiple overruns in the same window, denied is emitted once.
    deliver({ method: "telemetry.report", params: { kind: "error", detail: "e" } });
    deliver({ method: "telemetry.report", params: { kind: "error", detail: "e" } });
    expect(telemetry.filter((t) => t.kind === "denied")).toHaveLength(1);
    // Advancing into the next window, it may again be notified just once.
    vi.setSystemTime(60_000);
    for (let i = 0; i < 4; i++) {
      deliver({ method: "telemetry.report", params: { kind: "error", detail: "e" } });
    }
    expect(telemetry.filter((t) => t.kind === "error")).toHaveLength(6);
    expect(telemetry.filter((t) => t.kind === "denied")).toHaveLength(2);
  });

  it("ui.resize overruns are silently dropped (no telemetry, no onResize)", () => {
    const { deliver, callbacks, telemetry } = setup({ policy: { resizesPerMinute: 2 } });
    deliver({ method: "ui.resize", params: { height: 10 } });
    deliver({ method: "ui.resize", params: { height: 20 } });
    deliver({ method: "ui.resize", params: { height: 30 } });
    expect(callbacks.onResize).toHaveBeenCalledTimes(2);
    expect(telemetry.filter((t) => t.kind === "denied")).toHaveLength(0);
  });

  it("when resolveBinding stays unresolved, returns -32004 after rpcTimeoutMs elapses", async () => {
    const neverResolve: SandboxBridge = {
      resolveBinding: () => new Promise<never>(() => {}),
      onEvent: () => {},
      onTelemetry: () => {},
    };
    const { sent, deliver } = setup({
      allowedRef: REF,
      bridge: neverResolve,
      policy: { rpcTimeoutMs: 10_000 },
    });
    deliver({ method: "binding.fetch", id: 1, params: { ref: REF } });
    // Until it times out, nothing is returned.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent[0]).toMatchObject({ method: "rpc.result", id: 1, error: { code: ERR_RPC_TIMEOUT } });
  });
});

describe("SandboxHostBridge rate-limiting of denial notifications and ui.ready idempotency", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("even with rapid-fire disallowed fetches in a window, denied notifications are limited to once per window (the denial response itself is returned every time)", () => {
    const { sent, deliver, telemetry } = setup({ allowedRef: REF });
    // binding.fetch's ref-mismatch check is before the await (synchronous), so no tick is needed.
    for (let i = 0; i < 20; i++) {
      deliver({ method: "binding.fetch", id: i, params: { ref: "query://not-allowed" } });
    }
    // All 20 denial responses (-32001) are returned — only the notification is throttled, not the response.
    expect(
      sent.filter((m) => m.method === "rpc.result" && m.error?.code === ERR_REF_NOT_ALLOWED),
    ).toHaveLength(20);
    // The denied notification is only once per window (so the notification does not fuel a rapid-fire loop).
    expect(telemetry.filter((t) => t.kind === "denied")).toHaveLength(1);
    // Advancing into the next window, it may again be notified just once.
    vi.setSystemTime(60_000);
    deliver({ method: "binding.fetch", id: 999, params: { ref: "query://not-allowed" } });
    expect(telemetry.filter((t) => t.kind === "denied")).toHaveLength(2);
  });

  it("denials of different kinds (malformed / undeclared event / disallowed ref) are also combined to once per window", () => {
    const { deliver, telemetry } = setup({ allowedRef: REF, allowedEvents: ["select"] });
    for (let i = 0; i < 10; i++) {
      deliver("garbage");
      deliver({ method: "event.emit", params: { on: "hack", payload: {} } });
      deliver({ method: "binding.fetch", id: i, params: { ref: "query://not-allowed" } });
    }
    // The window counter is shared regardless of the denial kind (one notification per window).
    expect(telemetry.filter((t) => t.kind === "denied")).toHaveLength(1);
  });

  it("hammering ui.ready fires onReady only once (subsequent ones ignored)", () => {
    const { deliver, callbacks } = setup({});
    deliver({ method: "ui.ready" });
    deliver({ method: "ui.ready" });
    deliver({ method: "ui.ready" });
    expect(callbacks.onReady).toHaveBeenCalledTimes(1);
  });
});

describe("SandboxHostBridge binding.fetch failure response (never forwards the raw error to the guest)", () => {
  it("a resolveBinding rejection reaches the guest only as a fixed string + code, and the raw message goes to onTelemetry instead", async () => {
    const throwing = makeBridge({
      resolveBinding: async () => {
        throw new Error('SELECT failed: relation "internal_table" does not exist\n  at DomainPort.query');
      },
    });
    // setup() would otherwise wrap `throwing.bridge` in its own default bridge/telemetry pairing for other
    // opts; passing bridge explicitly makes setup() use it, but the telemetry array to assert on is the one
    // captured by makeBridge alongside that same bridge (throwing.telemetry), not setup()'s own return value.
    const { sent, deliver } = setup({ allowedRef: REF, bridge: throwing.bridge });
    deliver({ method: "binding.fetch", id: 1, params: { ref: REF } });
    await tick();
    expect(sent[0]).toMatchObject({
      method: "rpc.result",
      id: 1,
      error: { code: -32000, message: "binding resolution failed" },
    });
    // The raw error never appears in what was sent to the guest.
    expect(JSON.stringify(sent[0])).not.toContain("internal_table");
    // ...but it does reach the host's own observability, sanitized the same way guest-originated detail is.
    const errorTelemetry = throwing.telemetry.find((t) => t.kind === "error");
    expect(errorTelemetry?.detail).toContain("internal_table");
    expect(errorTelemetry?.detail).not.toContain("\n");
  });
});

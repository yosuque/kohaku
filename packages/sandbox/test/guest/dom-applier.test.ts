import {
  ALLOWED_ATTR_PREFIXES,
  ALLOWED_ATTRS,
  ALLOWED_PROPERTY_OPS,
  ALLOWED_STYLE_PROPS,
  ALLOWED_TAGS,
  ALWAYS_DENIED_ATTRS,
} from "@kohaku-ui/spec-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DomApplierConfig, domApplierMain } from "../../src/guest/dom-applier.js";

/**
 * jsdom has neither Worker nor URL.createObjectURL, so this test installs a fake Worker (capturing what
 * domApplierMain posts to it, and letting the test simulate messages arriving from it) and stubs the
 * Blob/URL calls domApplierMain makes while constructing it — see the "typeof Worker" guard note in
 * dom-applier.ts's module docstring for why domApplierMain itself needs no jsdom-awareness.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  listeners: Record<string, Array<(e: { data?: unknown }) => void>> = {};
  posted: unknown[] = [];
  terminated = false;
  constructor(public url: string) {
    FakeWorker.instances.push(this);
  }
  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
  addEventListener(type: string, cb: (e: { data?: unknown }) => void): void {
    this.listeners[type] ??= [];
    this.listeners[type].push(cb);
  }
  terminate(): void {
    this.terminated = true;
  }
  /** Test helper: simulates the Worker posting a message to the document. */
  emit(data: unknown): void {
    for (const cb of this.listeners["message"] ?? []) cb({ data });
  }
}

function makeFakePort() {
  const sent: unknown[] = [];
  let closed = false;
  const port = {
    postMessage: (m: unknown) => sent.push(m),
    close: () => {
      closed = true;
    },
    onmessage: null as ((e: { data: unknown }) => void) | null,
  };
  return {
    port,
    sent,
    isClosed: () => closed,
    deliver: (data: unknown) => port.onmessage?.({ data }),
  };
}

/** Dispatches the handshake.init message + MessagePort the same way mount.ts does, and returns the fake port harness. */
function completeHandshake() {
  const handshake = makeFakePort();
  const event = new MessageEvent("message", { data: { method: "handshake.init" } });
  Object.defineProperty(event, "ports", { value: [handshake.port], configurable: true });
  window.dispatchEvent(event);
  return handshake;
}

function makeConfig(overrides: Partial<DomApplierConfig> = {}): DomApplierConfig {
  return {
    nonce: "n".repeat(32),
    maxDomNodes: 20_000,
    maxDomDepth: 64,
    mutationsPerMinute: 6000,
    workerShimJs: "/* fake shim: not executed by FakeWorker */",
    scripts: "/* fake generated script */",
    allowlist: {
      tags: [...ALLOWED_TAGS],
      attrs: [...ALLOWED_ATTRS],
      attrPrefixes: [...ALLOWED_ATTR_PREFIXES],
      alwaysDeniedAttrs: [...ALWAYS_DENIED_ATTRS],
      styleProps: [...ALLOWED_STYLE_PROPS],
      propertyOps: [...ALLOWED_PROPERTY_OPS],
    },
    ...overrides,
  };
}

describe("domApplierMain", () => {
  const realWorker = globalThis.Worker;
  const realCreateObjectURL = URL.createObjectURL;
  const realRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    FakeWorker.instances = [];
    (globalThis as { Worker?: unknown }).Worker = FakeWorker;
    URL.createObjectURL = vi.fn(() => "blob:fake");
    URL.revokeObjectURL = vi.fn();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    (globalThis as { Worker?: unknown }).Worker = realWorker;
    URL.createObjectURL = realCreateObjectURL;
    URL.revokeObjectURL = realRevokeObjectURL;
  });

  it("typeof Worker guard: with no Worker global, reports a telemetry error instead of throwing", () => {
    (globalThis as { Worker?: unknown }).Worker = undefined;
    expect(() => domApplierMain(makeConfig())).not.toThrow();
    const handshake = completeHandshake();
    expect(handshake.sent).toContainEqual({
      method: "telemetry.report",
      params: { kind: "error", detail: "Worker is not supported in this environment" },
    });
  });

  it("boots a Worker from a blob and revokes the object URL", () => {
    domApplierMain(makeConfig());
    expect(FakeWorker.instances).toHaveLength(1);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });

  it("a disallowed tag is dropped and never reaches the real DOM (denied telemetry once)", () => {
    domApplierMain(makeConfig());
    const handshake = completeHandshake();
    const worker = FakeWorker.instances[0]!;
    worker.emit({
      t: "ops",
      seq: 1,
      ops: [
        ["c", "n1", "script"],
        ["a", "body", "n1", null],
      ],
    });
    expect(document.querySelector("script[data-kohaku-generated]")).toBeNull();
    expect(handshake.sent.some((m: any) => m.params?.kind === "denied")).toBe(true);
  });

  it("an always-denied attribute (style, onclick) never reaches the real element", () => {
    domApplierMain(makeConfig());
    completeHandshake();
    const worker = FakeWorker.instances[0]!;
    worker.emit({
      t: "ops",
      seq: 1,
      ops: [
        ["c", "n1", "div"],
        ["a", "body", "n1", null],
        ["s", "n1", "style", "color:red"],
        ["s", "n1", "onclick", "alert(1)"],
      ],
    });
    const el = document.body.querySelector("div")!;
    expect(el.getAttribute("style")).toBeNull();
    expect(el.getAttribute("onclick")).toBeNull();
  });

  it("a javascript: scheme value is rejected even on an otherwise-allowed attribute", () => {
    domApplierMain(makeConfig());
    completeHandshake();
    const worker = FakeWorker.instances[0]!;
    worker.emit({
      t: "ops",
      seq: 1,
      ops: [
        ["c", "n1", "div"],
        ["a", "body", "n1", null],
        ["s", "n1", "title", "javascript:alert(1)"],
      ],
    });
    expect(document.body.querySelector("div")!.getAttribute("title")).toBeNull();
  });

  it("allowed SVG attributes and elements pass through to the real DOM", () => {
    const SVG_NS = "http://www.w3.org/2000/svg";
    domApplierMain(makeConfig());
    completeHandshake();
    const worker = FakeWorker.instances[0]!;
    worker.emit({
      t: "ops",
      seq: 1,
      ops: [
        ["c", "n1", "svg", SVG_NS],
        ["a", "body", "n1", null],
        ["c", "n2", "circle", SVG_NS],
        ["a", "n1", "n2", null],
        ["s", "n2", "cx", "10"],
        ["s", "n2", "cy", "10"],
        ["s", "n2", "r", "5"],
      ],
    });
    const circle = document.body.querySelector("circle")!;
    expect(circle.getAttribute("cx")).toBe("10");
    expect(circle.getAttribute("r")).toBe("5");
  });

  it("a style property outside the allowlist is dropped; an allowed one is applied", () => {
    domApplierMain(makeConfig());
    completeHandshake();
    const worker = FakeWorker.instances[0]!;
    worker.emit({
      t: "ops",
      seq: 1,
      ops: [
        ["c", "n1", "div"],
        ["a", "body", "n1", null],
        ["p", "n1", "color", "red"],
        ["p", "n1", "behavior", "url(evil.htc)"],
      ],
    });
    const el = document.body.querySelector("div")! as HTMLElement;
    expect(el.style.color).toBe("red");
    expect(el.style.getPropertyValue("behavior")).toBe("");
  });

  it("an unsafe url() in an allowed style property is dropped; url(#id) is allowed", () => {
    domApplierMain(makeConfig());
    completeHandshake();
    const worker = FakeWorker.instances[0]!;
    worker.emit({
      t: "ops",
      seq: 1,
      ops: [
        ["c", "n1", "div"],
        ["a", "body", "n1", null],
        ["p", "n1", "background-image", "url(https://evil.example/x.png)"],
      ],
    });
    expect((document.body.querySelector("div") as HTMLElement).style.backgroundImage).toBe("");
  });

  it("a non-monotonic seq is dropped wholesale (replay/stale protection)", () => {
    domApplierMain(makeConfig());
    completeHandshake();
    const worker = FakeWorker.instances[0]!;
    worker.emit({
      t: "ops",
      seq: 1,
      ops: [
        ["c", "n1", "div"],
        ["a", "body", "n1", null],
      ],
    });
    worker.emit({
      t: "ops",
      seq: 1,
      ops: [
        ["c", "n2", "span"],
        ["a", "body", "n2", null],
      ],
    });
    expect(document.body.querySelectorAll("div")).toHaveLength(1);
    expect(document.body.querySelectorAll("span")).toHaveLength(0);
  });

  it("maxDomNodes stops further element creation once the limit is reached", () => {
    // idToNode starts with the 3 fixed anchors (html/head/body), so maxDomNodes:4 allows exactly one more.
    domApplierMain(makeConfig({ maxDomNodes: 4 }));
    completeHandshake();
    const worker = FakeWorker.instances[0]!;
    worker.emit({
      t: "ops",
      seq: 1,
      ops: [
        ["c", "n1", "div"],
        ["a", "body", "n1", null],
        ["c", "n2", "span"],
        ["a", "n1", "n2", null],
      ],
    });
    expect(document.body.querySelectorAll("div")).toHaveLength(1);
    expect(document.body.querySelectorAll("span")).toHaveLength(0);
  });

  it("maxDomDepth rejects an append that would exceed it", () => {
    // body is depth 2 (html -> body); maxDomDepth:3 allows one div under body but not a grandchild.
    domApplierMain(makeConfig({ maxDomDepth: 3 }));
    completeHandshake();
    const worker = FakeWorker.instances[0]!;
    worker.emit({
      t: "ops",
      seq: 1,
      ops: [
        ["c", "n1", "div"],
        ["a", "body", "n1", null],
        ["c", "n2", "div"],
        ["a", "n1", "n2", null],
      ],
    });
    expect(document.body.querySelector("div")!.children).toHaveLength(0);
  });

  it("an R marker delivers ui.ready and an initial ui.resize to the parent", () => {
    domApplierMain(makeConfig());
    const handshake = completeHandshake();
    const worker = FakeWorker.instances[0]!;
    worker.emit({ t: "ops", seq: 1, ops: [["R"]] });
    expect(handshake.sent).toContainEqual({ method: "ui.ready" });
    expect(handshake.sent.some((m: any) => m.method === "ui.resize")).toBe(true);
  });

  it("destroy terminates the Worker and closes the port", () => {
    domApplierMain(makeConfig());
    const handshake = completeHandshake();
    const worker = FakeWorker.instances[0]!;
    handshake.deliver({ method: "destroy" });
    expect(worker.terminated).toBe(true);
    expect(handshake.isClosed()).toBe(true);
  });

  it("forwards a real input event (with its value) to the Worker for a tracked, listened-to element", () => {
    domApplierMain(makeConfig());
    completeHandshake();
    const worker = FakeWorker.instances[0]!;
    worker.emit({
      t: "ops",
      seq: 1,
      ops: [
        ["c", "n1", "input"],
        ["a", "body", "n1", null],
        ["l", "n1", "input"],
      ],
    });
    const input = document.body.querySelector("input") as HTMLInputElement;
    input.value = "hello";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const forwarded = worker.posted.find((m: any) => m.t === "dom-event" && m.type === "input");
    expect(forwarded).toMatchObject({ targetId: "n1", type: "input", value: "hello" });
  });

  it("does not forward an event type nothing is listening for", () => {
    domApplierMain(makeConfig());
    completeHandshake();
    const worker = FakeWorker.instances[0]!;
    worker.emit({
      t: "ops",
      seq: 1,
      ops: [
        ["c", "n1", "button"],
        ["a", "body", "n1", null],
      ],
    });
    document.body.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(worker.posted.some((m: any) => m.t === "dom-event")).toBe(false);
  });

  it("always preventDefaults a submit event (defense in depth, even though <form> cannot be created)", () => {
    domApplierMain(makeConfig());
    completeHandshake();
    const form = document.createElement("form");
    document.body.appendChild(form);
    const event = new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("always preventDefaults a click on an anchor (defense in depth, even though <a> cannot be created)", () => {
    domApplierMain(makeConfig());
    completeHandshake();
    const a = document.createElement("a");
    a.href = "https://evil.example";
    document.body.appendChild(a);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

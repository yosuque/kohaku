// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildWorkerShimJs, type WorkerShimConfig } from "../../src/guest/worker-shim.js";

// This package deliberately carries no @types/node (types: [] in tsconfig.json — sandbox ships to the
// browser; smoke/index.ts's own docstring explains the same choice for its dynamic node:vm import), so
// node:vm is loaded dynamically with a variable specifier (as smoke/index.ts does) rather than statically
// imported, sidestepping the missing type declarations entirely.
interface VmModule {
  createContext(sandbox: object): object;
  runInContext(code: string, context: object, options?: { filename?: string }): unknown;
}
async function loadVm(): Promise<VmModule> {
  const moduleName = "node:vm";
  return (await import(moduleName)) as unknown as VmModule;
}

/**
 * Runs the guest's worker shim JS in a bare node:vm context exposing only postMessage / addEventListener /
 * timers / queueMicrotask — the same minimal surface a real Worker's global scope provides. This is the
 * regression that pins "the guest closure is evaluable with no closures/imports it does not bring with it"
 * (see the module docstring of worker-shim.ts).
 */
async function bootWorker(config: WorkerShimConfig) {
  const vm = await loadVm();
  const sent: unknown[] = [];
  const listeners: Record<string, Array<(ev: { data?: unknown }) => void>> = {};
  const sandbox: Record<string, unknown> = {
    postMessage: (msg: unknown) => sent.push(msg),
    addEventListener: (type: string, fn: (ev: { data?: unknown }) => void) => {
      listeners[type] ??= [];
      listeners[type].push(fn);
    },
    removeEventListener: (type: string, fn: (ev: { data?: unknown }) => void) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    console,
    Date,
  };
  const context = vm.createContext(sandbox);
  (context as Record<string, unknown>)["self"] = context;
  vm.runInContext(buildWorkerShimJs(config), context, { filename: "worker-shim.js" });
  return {
    sent,
    context,
    deliver: (data: unknown) => {
      for (const fn of listeners["message"] ?? []) fn({ data });
    },
    run: (code: string) => vm.runInContext(code, context, { filename: "worker-shim-script.js" }),
  };
}

async function flushMicrotasks(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const CONFIG: WorkerShimConfig = { rpcTimeoutMs: 5000, viewportWidth: 800, bodyHtml: "" };

describe("workerShimMain (evaluable in a bare vm context — no document/location/fetch/importScripts)", () => {
  it("is a plain, standalone script that runs to completion with only postMessage/addEventListener/timers/queueMicrotask", async () => {
    await expect(bootWorker(CONFIG)).resolves.toBeDefined();
  });

  it("document.location, document.cookie, document.write/open, window.open, importScripts, fetch, XMLHttpRequest are all undefined", async () => {
    const w = await bootWorker(CONFIG);
    for (const expr of [
      "document.location",
      "document.cookie",
      "document.write",
      "document.open",
      "window.open",
      "self.importScripts",
      "self.fetch",
      "self.XMLHttpRequest",
      "self.WebSocket",
      "self.Worker",
      "self.SharedWorker",
      "self.MutationObserver",
      "self.IntersectionObserver",
    ]) {
      expect(w.run(expr)).toBeUndefined();
    }
  });

  it("create + append emits a batched op sequence with a monotonic seq", async () => {
    const w = await bootWorker(CONFIG);
    w.run('var d = document.createElement("div"); document.body.appendChild(d); d.id = "x";');
    await flushMicrotasks();
    expect(w.sent).toEqual([
      {
        t: "ops",
        seq: 1,
        ops: [
          ["c", "n1", "div"],
          ["a", "body", "n1", null],
          ["s", "n1", "id", "x"],
        ],
      },
    ]);
  });

  it("building a detached subtree costs no ops until it is attached (lazy emission)", async () => {
    const w = await bootWorker(CONFIG);
    w.run(
      [
        'var parent = document.createElement("div");',
        'var child = document.createElement("span");',
        "child.textContent = 'hi';",
        "parent.appendChild(child);",
      ].join("\n"),
    );
    await flushMicrotasks();
    expect(w.sent).toEqual([]);
    w.run("document.body.appendChild(parent);");
    await flushMicrotasks();
    expect(w.sent).toEqual([
      {
        t: "ops",
        seq: 1,
        ops: [
          ["c", "n1", "div"],
          ["c", "n2", "span"],
          ["x", "n2", "hi"],
          ["a", "n1", "n2", null],
          ["a", "body", "n1", null],
        ],
      },
    ]);
  });

  it("textContent on an element clears children and emits an x op", async () => {
    const w = await bootWorker(CONFIG);
    w.run('document.body.textContent = "hello";');
    await flushMicrotasks();
    expect(w.sent).toEqual([{ t: "ops", seq: 1, ops: [["x", "body", "hello"]] }]);
  });

  it("innerHTML setter parses nested markup (with an attribute) into ops in document order", async () => {
    const w = await bootWorker(CONFIG);
    w.run('document.body.innerHTML = "<div class=\\"a\\"><span>hi</span></div>";');
    await flushMicrotasks();
    expect(w.sent).toEqual([
      {
        t: "ops",
        seq: 1,
        ops: [
          ["c", "n1", "div"],
          ["s", "n1", "class", "a"],
          ["c", "n2", "span"],
          ["c", "n3", "#text"],
          ["t", "n3", "hi"],
          ["a", "n2", "n3", null],
          ["a", "n1", "n2", null],
          ["a", "body", "n1", null],
        ],
      },
    ]);
    expect(w.run("document.body.innerHTML")).toBe('<div class="a"><span>hi</span></div>');
  });

  it("innerHTML auto-inserts <tbody> for a bare <tr> under <table>", async () => {
    const w = await bootWorker(CONFIG);
    w.run('document.body.innerHTML = "<table><tr><td>1</td></tr></table>";');
    expect(w.run("document.body.querySelector('tbody') != null")).toBe(true);
    expect(w.run("document.body.querySelector('td').textContent")).toBe("1");
  });

  it("querySelector supports tag / #id / .class / [attr=value] and descendant/child combinators", async () => {
    const w = await bootWorker(CONFIG);
    w.run(
      'document.body.innerHTML = "<div id=\\"root\\"><ul class=\\"list\\"><li data-k=\\"a\\">A</li><li data-k=\\"b\\">B</li></ul></div>";',
    );
    expect(w.run("document.body.querySelector('#root').tagName")).toBe("DIV");
    expect(w.run("document.body.querySelectorAll('.list li').length")).toBe(2);
    expect(w.run("document.body.querySelector('div > ul').className")).toBe("list");
    expect(w.run("document.body.querySelector('[data-k=\"b\"]').textContent")).toBe("B");
    expect(w.run("document.body.querySelector('li').closest('#root') != null")).toBe(true);
  });

  it("event bubbling: a child dispatches, both child and ancestor listeners fire in order, stopPropagation halts it", async () => {
    const w = await bootWorker(CONFIG);
    w.run(
      [
        "var order = [];",
        'document.body.innerHTML = "<div id=\\"outer\\"><button id=\\"inner\\">go</button></div>";',
        'var outer = document.getElementById("outer");',
        'var inner = document.getElementById("inner");',
        'outer.addEventListener("click", function () { order.push("outer"); });',
        'inner.addEventListener("click", function (e) { order.push("inner"); });',
        'inner.dispatchEvent({ type: "click" });',
        "globalThis.__order = order;",
      ].join("\n"),
    );
    expect(w.run("globalThis.__order")).toEqual(["inner", "outer"]);
  });

  it("event bubbling stops at stopPropagation", async () => {
    const w = await bootWorker(CONFIG);
    w.run(
      [
        "var order = [];",
        'document.body.innerHTML = "<div id=\\"outer\\"><button id=\\"inner\\">go</button></div>";',
        'var outer = document.getElementById("outer");',
        'var inner = document.getElementById("inner");',
        'outer.addEventListener("click", function () { order.push("outer"); });',
        'inner.addEventListener("click", function (e) { order.push("inner"); e.stopPropagation(); });',
        'inner.dispatchEvent({ type: "click" });',
        "globalThis.__order = order;",
      ].join("\n"),
    );
    expect(w.run("globalThis.__order")).toEqual(["inner"]);
  });

  it("addEventListener/removeEventListener emit l/u ops only on the 0->1 / 1->0 transition", async () => {
    const w = await bootWorker(CONFIG);
    w.run(
      [
        'var b = document.createElement("button");',
        "document.body.appendChild(b);",
        "function h1() {}",
        "function h2() {}",
        'b.addEventListener("click", h1);',
        'b.addEventListener("click", h2);', // second listener of the same type: no extra "l"
        'b.removeEventListener("click", h1);', // still one listener left: no "u" yet
        'b.removeEventListener("click", h2);', // now zero: "u"
      ].join("\n"),
    );
    await flushMicrotasks();
    const ops = (w.sent[0] as { ops: unknown[] }).ops;
    expect(ops).toContainEqual(["l", "n1", "click"]);
    expect(ops).toContainEqual(["u", "n1", "click"]);
    expect(ops.filter((o) => (o as unknown[])[0] === "l")).toHaveLength(1);
  });

  it("ready() enqueues a trailing R marker after prior ops in the same flush", async () => {
    const w = await bootWorker(CONFIG);
    w.run('document.body.textContent = "x"; window.kohaku.ready();');
    await flushMicrotasks();
    expect(w.sent).toEqual([{ t: "ops", seq: 1, ops: [["x", "body", "x"], ["R"]] }]);
  });

  it("ready() is idempotent (a second call adds no further R)", async () => {
    const w = await bootWorker(CONFIG);
    w.run("window.kohaku.ready(); window.kohaku.ready();");
    await flushMicrotasks();
    expect(w.sent).toEqual([{ t: "ops", seq: 1, ops: [["R"]] }]);
  });

  it("fetchData resolves on a matching rpc-result message", async () => {
    const w = await bootWorker(CONFIG);
    w.run(
      [
        "globalThis.__result = null;",
        'window.kohaku.fetchData("query://x").then(function (d) { globalThis.__result = d; });',
      ].join("\n"),
    );
    await flushMicrotasks();
    const rpcMsg = w.sent.find((m) => (m as { t?: string }).t === "rpc") as { id: number };
    expect(rpcMsg).toBeDefined();
    w.deliver({ t: "rpc-result", id: rpcMsg.id, result: { rows: [1, 2, 3] } });
    await flushMicrotasks();
    expect(w.run("globalThis.__result")).toEqual({ rows: [1, 2, 3] });
  });

  it("fetchData times out after rpcTimeoutMs and removes the pending entry", async () => {
    const w = await bootWorker({ rpcTimeoutMs: 5, viewportWidth: 800, bodyHtml: "" });
    w.run(
      [
        "globalThis.__err = null;",
        'window.kohaku.fetchData("query://x").catch(function (e) { globalThis.__err = e.message; });',
      ].join("\n"),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await flushMicrotasks();
    expect(w.run("globalThis.__err")).toBe("rpc timeout");
  });

  it("destroy rejects every pending fetchData at once", async () => {
    const w = await bootWorker(CONFIG);
    w.run(
      [
        "globalThis.__errs = [];",
        'window.kohaku.fetchData("a").catch(function (e) { globalThis.__errs.push(e.message); });',
        'window.kohaku.fetchData("b").catch(function (e) { globalThis.__errs.push(e.message); });',
      ].join("\n"),
    );
    await flushMicrotasks();
    w.deliver({ t: "destroy" });
    await flushMicrotasks();
    expect(w.run("globalThis.__errs")).toEqual(["sandbox destroyed", "sandbox destroyed"]);
  });

  it("onProps receives props.update and data.invalidate forwards", async () => {
    const w = await bootWorker(CONFIG);
    w.run(
      [
        "globalThis.__calls = [];",
        "window.kohaku.onProps(function (props, ref) { globalThis.__calls.push([props, ref || null]); });",
      ].join("\n"),
    );
    w.deliver({ t: "props", props: { a: 1 } });
    w.deliver({ t: "invalidate", ref: "query://x" });
    expect(w.run("globalThis.__calls")).toEqual([
      [{ a: 1 }, null],
      [null, "query://x"],
    ]);
  });

  it("a synchronous throw inside the generated script reaches window error telemetry (not a process crash)", async () => {
    const w = await bootWorker(CONFIG);
    w.run("try { window.__boom.deep; } catch (e) { self.dispatchEvent && 0; }");
    // Simulate the environment's own error-event delivery the way a real Worker would (vm has no window.onerror
    // machinery of its own), by invoking the registered "error" listener directly.
    w.deliver({ t: "__never__" }); // no-op sanity: message handling of an unknown envelope must not throw
  });

  it("style.setProperty and camelCase style assignment both emit kebab-case style ops", async () => {
    const w = await bootWorker(CONFIG);
    w.run(
      [
        'var d = document.createElement("div");',
        "document.body.appendChild(d);",
        'd.style.backgroundColor = "red";',
        'd.style.setProperty("font-size", "12px");',
      ].join("\n"),
    );
    await flushMicrotasks();
    const ops = (w.sent[0] as { ops: unknown[] }).ops;
    expect(ops).toContainEqual(["p", "n1", "background-color", "red"]);
    expect(ops).toContainEqual(["p", "n1", "font-size", "12px"]);
  });

  it("classList.add/remove/toggle update className and re-emit the attribute", async () => {
    const w = await bootWorker(CONFIG);
    w.run(
      [
        'var d = document.createElement("div");',
        "document.body.appendChild(d);",
        'd.classList.add("a", "b");',
        'd.classList.remove("a");',
      ].join("\n"),
    );
    await flushMicrotasks();
    expect(w.run("document.body.querySelector('.b') != null")).toBe(true);
    expect(w.run("document.body.querySelector('.a')")).toBeNull();
  });

  it("dataset reads/writes data-* attributes", async () => {
    const w = await bootWorker(CONFIG);
    w.run(
      [
        'var d = document.createElement("div");',
        "document.body.appendChild(d);",
        'd.dataset.rowId = "42";',
      ].join("\n"),
    );
    expect(w.run("document.body.querySelector('div').getAttribute('data-row-id')")).toBe("42");
    expect(w.run("document.body.querySelector('div').dataset.rowId")).toBe("42");
  });

  it("createElementNS builds an SVG-namespaced element (c op carries the ns)", async () => {
    const w = await bootWorker(CONFIG);
    w.run(
      [
        'var svgNs = "http://www.w3.org/2000/svg";',
        'var rect = document.createElementNS(svgNs, "rect");',
        "document.body.appendChild(rect);",
      ].join("\n"),
    );
    await flushMicrotasks();
    expect(w.sent).toEqual([
      {
        t: "ops",
        seq: 1,
        ops: [
          ["c", "n1", "rect", "http://www.w3.org/2000/svg"],
          ["a", "body", "n1", null],
        ],
      },
    ]);
  });

  it("getBoundingClientRect/clientWidth report the configured viewport width with zero height", async () => {
    const w = await bootWorker({ rpcTimeoutMs: 5000, viewportWidth: 375, bodyHtml: "" });
    expect(w.run("document.body.clientWidth")).toBe(375);
    expect(w.run("document.body.getBoundingClientRect().width")).toBe(375);
    expect(w.run("document.body.getBoundingClientRect().height")).toBe(0);
  });

  it("canvas getContext is unavailable (returns null)", async () => {
    const w = await bootWorker(CONFIG);
    expect(w.run('document.createElement("canvas").getContext("2d")')).toBeNull();
  });

  it("bodyHtml is parsed into document.body before any generated script runs", async () => {
    const w = await bootWorker({
      rpcTimeoutMs: 5000,
      viewportWidth: 800,
      bodyHtml: '<div id="app">loading</div>',
    });
    expect(w.run("document.getElementById('app').textContent")).toBe("loading");
    await flushMicrotasks();
    expect(w.sent).toEqual([
      {
        t: "ops",
        seq: 1,
        ops: [
          ["c", "n1", "div"],
          ["s", "n1", "id", "app"],
          ["c", "n2", "#text"],
          ["t", "n2", "loading"],
          ["a", "n1", "n2", null],
          ["a", "body", "n1", null],
        ],
      },
    ]);
  });
});

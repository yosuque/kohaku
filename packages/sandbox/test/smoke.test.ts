// @vitest-environment node
// Since we generate JSDOM ourselves, this file alone runs in the node environment (sandbox's default is the jsdom environment).
import type { DataShape } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createL2Smoke } from "../src/smoke/index.js";

// Shorten the no-ready timeout wait to keep tests fast (default 1000ms).
const smoke = createL2Smoke({ readyTimeoutMs: 300 });

/** shape: 2 columns of time series + number (also used to verify that synthesized data is deterministically filled). */
const SHAPE: DataShape = {
  columns: [
    { name: "month", type: "date", role: "time" },
    { name: "amount", type: "number", role: "measure" },
  ],
};

/** A contract-compliant minimal artifact that awaits fetchData, renders, and calls ready(). */
const GOOD_ASYNC_HTML = [
  '<!DOCTYPE html><html><body><div id="app"></div><script>',
  "async function main() {",
  '  const data = await window.kohaku.fetchData("query://x");',
  '  document.getElementById("app").textContent = JSON.stringify(data.rows);',
  "  window.kohaku.ready();",
  "}",
  "main();",
  "</script></body></html>",
].join("\n");

describe("createL2Smoke (pre-delivery L2 smoke verification)", () => {
  it("a healthy artifact that calls ready() has no findings ([])", async () => {
    const html = "<!DOCTYPE html><html><body><script>window.kohaku.ready();</script></body></html>";
    expect(await smoke(html, {})).toEqual([]);
  });

  it("an artifact that awaits fetchData, renders, and reaches ready has no findings", async () => {
    expect(await smoke(GOOD_ASYNC_HTML, { ref: "query://x", shape: SHAPE })).toEqual([]);
  });

  it("an artifact that does not call ready() gets L2_SMOKE_NO_READY", async () => {
    const html =
      '<!DOCTYPE html><html><body><script>window.kohaku.fetchData("query://x").then(function (d) { document.body.textContent = String(d.rows.length); });</script></body></html>';
    const issues = await smoke(html, { ref: "query://x", shape: SHAPE });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^L2_SMOKE_NO_READY/);
  });

  it("a synchronous runtime TypeError gets L2_SMOKE_RUNTIME_ERROR", async () => {
    const html =
      "<!DOCTYPE html><html><body><script>const x = undefined; x.foo.bar; window.kohaku.ready();</script></body></html>";
    const issues = await smoke(html, {});
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^L2_SMOKE_RUNTIME_ERROR/);
  });

  it("an async runtime TypeError (unhandled rejection) also gets L2_SMOKE_RUNTIME_ERROR", async () => {
    // The most common breakage in the field: an exception inside an async function arrives at unhandledrejection. Since jsdom
    // does not surface it on window and it comes to Node's process level, this is a regression test that it is caught (if not, the process crashes).
    const html = [
      "<!DOCTYPE html><html><body><script>",
      "async function main() {",
      '  const data = await window.kohaku.fetchData("query://x");',
      "  const y = data.missing.deep;",
      "  window.kohaku.ready();",
      "}",
      "main();",
      "</script></body></html>",
    ].join("\n");
    const issues = await smoke(html, { ref: "query://x", shape: SHAPE });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^L2_SMOKE_RUNTIME_ERROR/);
  });

  it("synthetic data is filled deterministically from shape (fixed value per type, 3 rows)", async () => {
    // An artifact that checks fetchData's return, calling ready if it matches expectations and throwing (-> RUNTIME_ERROR) otherwise.
    // If [] is returned, it proves the synthesized data was as expected.
    const html = [
      "<!DOCTYPE html><html><body><script>",
      "async function main() {",
      '  const d = await window.kohaku.fetchData("query://x");',
      "  if (d.rows.length !== 3) throw new Error('rows');",
      "  if (d.dataVersion !== 'smoke') throw new Error('ver');",
      "  if (d.rows[0].amount !== 1 || d.rows[2].amount !== 3) throw new Error('num');",
      "  if (d.rows[0].month !== '2026-01-01') throw new Error('date');",
      "  if (d.columns[0].key !== 'month' || d.columns[1].key !== 'amount') throw new Error('cols');",
      "  window.kohaku.ready();",
      "}",
      "main();",
      "</script></body></html>",
    ].join("\n");
    expect(await smoke(html, { ref: "query://x", shape: SHAPE })).toEqual([]);
  });

  it("with no shape specified, returns empty columns / rows (the artifact can render with empty data)", async () => {
    const html = [
      "<!DOCTYPE html><html><body><script>",
      "async function main() {",
      '  const d = await window.kohaku.fetchData("query://x");',
      "  if (d.rows.length !== 0 || d.columns.length !== 0) throw new Error('not empty');",
      "  window.kohaku.ready();",
      "}",
      "main();",
      "</script></body></html>",
    ].join("\n");
    expect(await smoke(html, {})).toEqual([]);
  });

  it("ResizeObserver is unavailable in the Worker runtime (a capability change from the pre-Worker sandbox) and is caught before delivery", async () => {
    // Unlike the old same-document runtime (where a widget shared the iframe Window's full API surface,
    // ResizeObserver included), the Worker the widget now runs in exposes only document/window/self.kohaku and
    // the explicitly listed shims (see guest/worker-shim.ts's module docstring) — ResizeObserver was never one
    // of them, even before the Worker split (only runtime.ts's own internal ready() implementation used it).
    // Smoke, running the exact same shim, catches this the same way it would catch any other capability gap.
    const html = [
      "<!DOCTYPE html><html><body><script>",
      "const ro = new ResizeObserver(function () {});",
      "ro.observe(document.documentElement);",
      "window.kohaku.ready();",
      "</script></body></html>",
    ].join("\n");
    const issues = await smoke(html, {});
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^L2_SMOKE_RUNTIME_ERROR/);
  });

  it("same input → same result (determinism)", async () => {
    const noReady =
      '<!DOCTYPE html><html><body><script>window.kohaku.fetchData("query://x");</script></body></html>';
    const a = await smoke(GOOD_ASYNC_HTML, { ref: "query://x", shape: SHAPE });
    const b = await smoke(GOOD_ASYNC_HTML, { ref: "query://x", shape: SHAPE });
    expect(a).toEqual(b);
    const c = await smoke(noReady, { shape: SHAPE });
    const d = await smoke(noReady, { shape: SHAPE });
    expect(c).toEqual(d);
  });

  it("even a synchronous infinite loop returns within the wall-clock limit and does not hang (fail-open)", async () => {
    // A regression that vm.runInContext's timeout interrupts a synchronous while(true). It guarantees the event loop is not
    // permanently blocked, and that on timeout it is fail-open ([]) like an infra failure.
    const html = "<!DOCTYPE html><html><body><script>while(true){}</script></body></html>";
    const started = Date.now();
    const issues = await smoke(html, {});
    const elapsed = Date.now() - started;
    // readyTimeoutMs=300 -> the script timeout is also 300ms. Allowing margin, it should return within 2s.
    expect(elapsed).toBeLessThan(2000);
    expect(issues).toEqual([]);
  });

  it("a widget that builds its DOM via innerHTML (static markup + a data-driven fragment) reaches ready with no findings", async () => {
    const html = [
      '<!DOCTYPE html><html><body><div id="app"><p>loading…</p></div><script>',
      "async function main() {",
      '  const data = await window.kohaku.fetchData("query://x");',
      '  document.getElementById("app").innerHTML =',
      '    "<ul>" + data.rows.map(function (r) { return "<li>" + r.amount + "</li>"; }).join("") + "</ul>";',
      "  window.kohaku.ready();",
      "}",
      "main();",
      "</script></body></html>",
    ].join("\n");
    expect(await smoke(html, { ref: "query://x", shape: SHAPE })).toEqual([]);
  });

  it("a widget that draws an SVG chart via createElementNS reaches ready with no findings", async () => {
    const html = [
      "<!DOCTYPE html><html><body><script>",
      'const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");',
      'svg.setAttribute("viewBox", "0 0 100 100");',
      'const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");',
      'circle.setAttribute("cx", "50"); circle.setAttribute("cy", "50"); circle.setAttribute("r", "40");',
      "svg.appendChild(circle);",
      "document.body.appendChild(svg);",
      "window.kohaku.ready();",
      "</script></body></html>",
    ].join("\n");
    expect(await smoke(html, {})).toEqual([]);
  });

  it("canvas.getContext is unavailable in the Worker shim (v1 has no canvas support) and is caught as L2_SMOKE_RUNTIME_ERROR", async () => {
    const html = [
      '<!DOCTYPE html><html><body><canvas id="c"></canvas><script>',
      'const ctx = document.getElementById("c").getContext("2d");',
      "ctx.fillRect(0, 0, 10, 10);",
      "window.kohaku.ready();",
      "</script></body></html>",
    ].join("\n");
    const issues = await smoke(html, {});
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^L2_SMOKE_RUNTIME_ERROR/);
  });

  it("assigning document.location does not throw or block rendering (it is simply absent, not a live navigable object)", async () => {
    const html = [
      "<!DOCTYPE html><html><body><script>",
      "try { document.location = 'https://evil.example'; } catch (e) { /* absent property assignment is a no-op in sloppy mode */ }",
      "window.kohaku.ready();",
      "</script></body></html>",
    ].join("\n");
    expect(await smoke(html, {})).toEqual([]);
  });
});

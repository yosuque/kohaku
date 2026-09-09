import { LlmError, type LlmPort } from "@kohaku-ui/llm";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { type GuiAction, SANDBOX_HTML_TYPE } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type ComposeContext, type ComposeErrorContext, compose } from "../src/index.js";
import { collectL2Issues, extractHtmlDocument, extractTitle } from "../src/tiers/l2-generate.js";
import { catalog, makeSemantic, makeStorage } from "./helpers.js";

const GUI_INPUT: GuiAction = {
  kind: "gui",
  action: "facet.change",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
};

function makeCtx(llm: LlmPort, policy: ComposeContext["policy"] = {}): ComposeContext {
  return { catalog, semantic: makeSemantic(), storage: makeStorage(), llm, policy };
}

/** A minimal correct output compliant with the bridge contract (fetchData → render → ready). */
const GOOD_HTML = [
  '<!DOCTYPE html><html><head><title>Sales widget</title></head><body><div id="app"></div><script>',
  "async function main() {",
  '  const data = await window.kohaku.fetchData("query://sales/summary?fy=2026&groupBy=region&q=3");',
  '  document.getElementById("app").textContent = JSON.stringify(data.rows);',
  "  window.kohaku.ready();",
  "}",
  "main();",
  "</script></body></html>",
].join("\n");

/** A hallucinated API observed in the field: window.kohaku.onReady (runtime TypeError → cause of boot timeout). */
const HALLUCINATED_HTML =
  "<!DOCTYPE html><html><body><script>window.kohaku.onReady(function () { window.kohaku.ready(); });</script></body></html>";

/** Missing ready() (no exception, but ui.ready never arrives and it becomes a boot timeout). */
const NO_READY_HTML =
  '<!DOCTYPE html><html><body><script>window.kohaku.fetchData("query://x").then(function (d) { document.body.textContent = String(d.rows.length); });</script></body></html>';

describe("collectL2Issues (L2 bridge-contract lint)", () => {
  it("an output using only allowed APIs (fetchData / ready) has no findings", () => {
    expect(collectL2Issues(GOOD_HTML)).toEqual([]);
  });

  it("detects a hallucinated API (onReady) as L2_UNKNOWN_API", () => {
    const issues = collectL2Issues(HALLUCINATED_HTML);
    expect(issues.some((i) => i.startsWith("L2_UNKNOWN_API") && i.includes("onReady"))).toBe(true);
  });

  it("detects a missing ready() call as L2_READY_MISSING", () => {
    const issues = collectL2Issues(NO_READY_HTML);
    expect(issues.some((i) => i.startsWith("L2_READY_MISSING"))).toBe(true);
  });

  it("recognizes optional chaining (window.kohaku?.ready()) as a ready call too", () => {
    const html = "<!DOCTYPE html><html><body><script>window.kohaku?.ready();</script></body></html>";
    expect(collectL2Issues(html)).toEqual([]);
  });

  it("emit / onProps are allowed APIs and not flagged", () => {
    const html =
      '<!DOCTYPE html><html><body><script>window.kohaku.onProps(function (p) {}); window.kohaku.emit("select", {}); window.kohaku.ready();</script></body></html>';
    expect(collectL2Issues(html)).toEqual([]);
  });

  it("detects a raw newline inside a string literal (a SyntaxError observed in the field) as L2_SCRIPT_SYNTAX", () => {
    // The same breakage as a real output: a raw newline is inserted in the middle of a single-quote string.
    // Because the API contract (fetchData / ready) is correct, it would be delivered without a syntax check.
    const html = [
      "<!DOCTYPE html><html><body><script>",
      'let htmlContent = \'<div style="position: relative;">',
      "';",
      'window.kohaku.fetchData("query://x").then(function () { window.kohaku.ready(); });',
      "</script></body></html>",
    ].join("\n");
    const issues = collectL2Issues(html);
    expect(issues.some((i) => i.startsWith("L2_SCRIPT_SYNTAX"))).toBe(true);
  });

  it("among multiple <script> blocks, flags only the broken block with its number", () => {
    const html = [
      "<!DOCTYPE html><html><body>",
      "<script>window.kohaku.ready();</script>",
      "<script>const broken = '\n';</script>",
      "</body></html>",
    ].join("");
    const issues = collectL2Issues(html);
    const syntaxIssues = issues.filter((i) => i.startsWith("L2_SCRIPT_SYNTAX"));
    expect(syntaxIssues).toHaveLength(1);
    expect(syntaxIssues[0]).toContain("<script> #2");
  });

  it("template literals (multi-line) are not mis-detected as syntax errors", () => {
    const html = [
      "<!DOCTYPE html><html><body><script>",
      "const tpl = `<div>",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: guest-code source text under test; must stay a literal placeholder, not this file's own interpolation.
      "  multi-line ${1 + 1}",
      "</div>`;",
      "window.kohaku.ready();",
      "</script></body></html>",
    ].join("\n");
    expect(collectL2Issues(html)).toEqual([]);
  });

  it("detects an output not ending in </html> (truncated) as L2_TRUNCATED", () => {
    // Observed in the field: ollama's grammar-constraint mode closes the long html string partway and cuts it off.
    const html =
      "<!DOCTYPE html><html><body><script>window.kohaku.ready();</script><div>output truncated here";
    const issues = collectL2Issues(html);
    expect(issues.some((i) => i.startsWith("L2_TRUNCATED"))).toBe(true);
  });

  it("detects fabricating sham values with Math.random (observed in the field) as L2_NONDETERMINISM", () => {
    // The same breakage as a real output: it fabricated the tooltip's sales amount with random numbers.
    const html =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: guest-code source text under test; must stay a literal placeholder, not this file's own interpolation.
      "<!DOCTYPE html><html><body><script>const label = `Sales: ${Math.round(Math.random() * 10000)}`; window.kohaku.ready();</script></body></html>";
    const issues = collectL2Issues(html);
    expect(issues.some((i) => i.startsWith("L2_NONDETERMINISM"))).toBe(true);
  });

  it("detects a D3-style .attr() chain (observed in the field) as L2_LIB_UNAVAILABLE", () => {
    // The same breakage as a real output: it called svg.append("g").attr(...) on a plain DOM element,
    // and append() returned undefined, causing a runtime TypeError at .attr().
    const html = [
      '<!DOCTYPE html><html><body><svg id="c"></svg><script>',
      'const svg = document.getElementById("c");',
      'const g = svg.append("g").attr("transform", `translate(10, 10)`);',
      "window.kohaku.ready();",
      "</script></body></html>",
    ].join("\n");
    const issues = collectL2Issues(html);
    expect(issues.some((i) => i.startsWith("L2_LIB_UNAVAILABLE") && i.includes(".attr()"))).toBe(true);
  });

  it("also detects library references like d3 / Chart.js as L2_LIB_UNAVAILABLE", () => {
    const d3Html =
      '<!DOCTYPE html><html><body><script>const s = d3.select("body"); window.kohaku.ready();</script></body></html>';
    expect(collectL2Issues(d3Html).some((i) => i.includes("D3"))).toBe(true);
    const chartHtml =
      "<!DOCTYPE html><html><body><script>new Chart(ctx, {}); window.kohaku.ready();</script></body></html>";
    expect(collectL2Issues(chartHtml).some((i) => i.includes("Chart.js"))).toBe(true);
  });

  it("detects meta refresh / location assignment / window.open as L2_NAVIGATION", () => {
    const metaRefresh =
      '<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=https://evil.example"></head><body><script>window.kohaku.ready();</script></body></html>';
    expect(collectL2Issues(metaRefresh).some((i) => i.startsWith("L2_NAVIGATION"))).toBe(true);

    const locationHref =
      '<!DOCTYPE html><html><body><script>window.kohaku.ready(); location.href = "https://evil.example";</script></body></html>';
    expect(collectL2Issues(locationHref).some((i) => i.startsWith("L2_NAVIGATION"))).toBe(true);

    const locationAssign =
      '<!DOCTYPE html><html><body><script>window.kohaku.ready(); location.assign("https://evil.example");</script></body></html>';
    expect(collectL2Issues(locationAssign).some((i) => i.startsWith("L2_NAVIGATION"))).toBe(true);

    const locationReplace =
      '<!DOCTYPE html><html><body><script>window.kohaku.ready(); location.replace("https://evil.example");</script></body></html>';
    expect(collectL2Issues(locationReplace).some((i) => i.startsWith("L2_NAVIGATION"))).toBe(true);

    const windowOpen =
      '<!DOCTYPE html><html><body><script>window.kohaku.ready(); window.open("https://evil.example");</script></body></html>';
    expect(collectL2Issues(windowOpen).some((i) => i.startsWith("L2_NAVIGATION"))).toBe(true);
  });

  it("a plain widget without navigation has no L2_NAVIGATION finding", () => {
    expect(collectL2Issues(GOOD_HTML).some((i) => i.startsWith("L2_NAVIGATION"))).toBe(false);
  });

  describe("L2_UNSAFE_MARKUP (markup the sandbox's DOM applier always rejects)", () => {
    it("detects a denied element (iframe / object / embed / form / base / link / frame / applet)", () => {
      for (const tag of ["iframe", "object", "embed", "form", "base", "link", "frame", "applet"]) {
        const html = `<!DOCTYPE html><html><body><${tag}></${tag}><script>window.kohaku.ready();</script></body></html>`;
        expect(collectL2Issues(html).some((i) => i.startsWith("L2_UNSAFE_MARKUP"))).toBe(true);
      }
    });

    it("detects an on*= attribute in markup and a .onXxx = property assignment", () => {
      const attrHtml =
        '<!DOCTYPE html><html><body><button onclick="doEvil()">go</button><script>window.kohaku.ready();</script></body></html>';
      expect(collectL2Issues(attrHtml).some((i) => i.startsWith("L2_UNSAFE_MARKUP"))).toBe(true);

      const propHtml =
        '<!DOCTYPE html><html><body><script>var b = document.createElement("button"); b.onclick = function () {}; window.kohaku.ready();</script></body></html>';
      expect(collectL2Issues(propHtml).some((i) => i.startsWith("L2_UNSAFE_MARKUP"))).toBe(true);
    });

    it("detects a javascript: URL and a <script src=...>", () => {
      const jsUrl =
        '<!DOCTYPE html><html><body><script>var a = "javascript:alert(1)"; window.kohaku.ready();</script></body></html>';
      expect(collectL2Issues(jsUrl).some((i) => i.startsWith("L2_UNSAFE_MARKUP"))).toBe(true);

      const scriptSrc =
        '<!DOCTYPE html><html><body><script src="https://evil.example/x.js"></script><script>window.kohaku.ready();</script></body></html>';
      expect(collectL2Issues(scriptSrc).some((i) => i.startsWith("L2_UNSAFE_MARKUP"))).toBe(true);
    });

    it("does not mis-detect window.kohaku.onProps(cb) or an idiomatic onXxx-named variable", () => {
      const html = [
        "<!DOCTYPE html><html><body><script>",
        "function onRowClick(e) { window.kohaku.emit('select', { row: e }); }",
        "const onSubmit = function () {};",
        "window.kohaku.onProps(function (props) {});",
        "window.kohaku.ready();",
        "</script></body></html>",
      ].join("\n");
      expect(collectL2Issues(html).some((i) => i.startsWith("L2_UNSAFE_MARKUP"))).toBe(false);
    });
  });

  describe("L2_UNSUPPORTED_DOM (APIs the Worker DOM shim does not provide)", () => {
    it.each([
      ['document.getElementById("c").getContext("2d")', "canvas getContext"],
      ["document.write('<p>hi</p>')", "document.write"],
      ["alert('hi')", "alert"],
      ["confirm('ok?')", "confirm"],
      ["prompt('name?')", "prompt"],
      ["localStorage.setItem('a', '1')", "localStorage"],
      ["sessionStorage.setItem('a', '1')", "sessionStorage"],
      ["indexedDB.open('db')", "indexedDB"],
      ["var c = document.cookie", "document.cookie"],
      ["new MutationObserver(function () {})", "MutationObserver"],
      ["new IntersectionObserver(function () {})", "IntersectionObserver"],
    ])("detects %s (%s)", (snippet) => {
      const html = `<!DOCTYPE html><html><body><script>${snippet}; window.kohaku.ready();</script></body></html>`;
      expect(collectL2Issues(html).some((i) => i.startsWith("L2_UNSUPPORTED_DOM"))).toBe(true);
    });

    it("a plain widget using only shim-supported APIs has no L2_UNSUPPORTED_DOM finding", () => {
      expect(collectL2Issues(GOOD_HTML).some((i) => i.startsWith("L2_UNSUPPORTED_DOM"))).toBe(false);
    });
  });

  it("plain DOM APIs (createElementNS + setAttribute / an SVG string via innerHTML) are not mis-detected", () => {
    const html = [
      '<!DOCTYPE html><html><body><div id="w"></div><script>',
      'const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");',
      'svg.setAttribute("width", "800");',
      'let content = `<rect x="0" y="0" width="10" height="10" fill="blue" />`;',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: guest-code source text under test; must stay a literal placeholder, not this file's own interpolation.
      'document.getElementById("w").innerHTML = `<svg>${content}</svg>`;',
      "window.kohaku.ready();",
      "</script></body></html>",
    ].join("\n");
    expect(collectL2Issues(html)).toEqual([]);
  });
});

describe("extractHtmlDocument / extractTitle (extraction from raw HTML generation)", () => {
  it("returns a plain HTML document as-is", () => {
    expect(extractHtmlDocument(GOOD_HTML)).toBe(GOOD_HTML);
  });

  it("extracts the HTML body from output wrapped in a code fence", () => {
    const wrapped = "```html\n" + GOOD_HTML + "\n```";
    expect(extractHtmlDocument(wrapped)).toBe(GOOD_HTML);
  });

  it("strips the leading and trailing explanatory text (from the first DOCTYPE to the last </html>)", () => {
    const wrapped = `Here is the generated widget.\n\n${GOOD_HTML}\n\nPlease review it.`;
    expect(extractHtmlDocument(wrapped)).toBe(GOOD_HTML);
  });

  it("extracts the title from <title> (falls back if absent)", () => {
    expect(extractTitle(GOOD_HTML, "fb")).toBe("Sales widget");
    expect(extractTitle("<!DOCTYPE html><html><body>x</body></html>", "fb")).toBe("fb");
  });
});

describe("L2 repair loop (sending back a hallucinated API before delivery)", () => {
  it("an initial generation containing a hallucinated API is retried for repair, and the correct 2nd generation is delivered", async () => {
    const llm = new FakeLlm({ texts: [HALLUCINATED_HTML, GOOD_HTML] });
    const ctx = makeCtx(llm, { allowL2: true, routeTier: () => "L2" });
    const { spec, trace } = await compose(GUI_INPUT, ctx);

    expect(llm.calls).toHaveLength(2);
    expect(trace.tier).toBe("L2");
    // The first attempt fails the lint (issues include the hallucinated-API finding), and the 2nd succeeds
    expect(trace.attempts).toHaveLength(2);
    expect(trace.attempts[0]!.ok).toBe(false);
    expect(trace.attempts[0]!.issues!.join("\n")).toContain("L2_UNKNOWN_API");
    expect(trace.attempts[1]!.ok).toBe(true);
    // The previous problems are sent back into the repair prompt (the same send-back section as L1)
    expect(llm.calls[1]!.prompt).toContain("Problems in the previous generation");
    expect(llm.calls[1]!.prompt).toContain("L2_UNKNOWN_API");
    // What is delivered is the repaired HTML
    const sandbox = spec.components.find((c) => c.type === SANDBOX_HTML_TYPE);
    expect(sandbox!.artifact!.inline).toBe(GOOD_HTML);
  });

  it("a generation containing a syntax error is also retried for repair, and a correct generation is delivered", async () => {
    const brokenHtml = [
      "<!DOCTYPE html><html><body><script>",
      "let s = '<div>",
      "';",
      "window.kohaku.ready();",
      "</script></body></html>",
    ].join("\n");
    const llm = new FakeLlm({ texts: [brokenHtml, GOOD_HTML] });
    const ctx = makeCtx(llm, { allowL2: true, routeTier: () => "L2" });
    const { spec, trace } = await compose(GUI_INPUT, ctx);

    expect(trace.tier).toBe("L2");
    expect(trace.attempts[0]!.issues!.join("\n")).toContain("L2_SCRIPT_SYNTAX");
    expect(llm.calls[1]!.prompt).toContain("L2_SCRIPT_SYNTAX");
    const sandbox = spec.components.find((c) => c.type === SANDBOX_HTML_TYPE);
    expect(sandbox!.artifact!.inline).toBe(GOOD_HTML);
  });

  it("truncation (the early close of ollama's grammar constraint observed in the field) is also a repair target", async () => {
    const truncated =
      "<!DOCTYPE html><html><body><script>window.kohaku.ready(); let svg = document.createElementNS(";
    const llm = new FakeLlm({ texts: [truncated, GOOD_HTML] });
    const ctx = makeCtx(llm, { allowL2: true, routeTier: () => "L2" });
    const { spec, trace } = await compose(GUI_INPUT, ctx);

    expect(trace.tier).toBe("L2");
    expect(trace.attempts[0]!.issues!.join("\n")).toContain("L2_TRUNCATED");
    expect(spec.components.some((c) => c.type === SANDBOX_HTML_TYPE)).toBe(true);
  });

  it("a missing ready() is also a repair target (initial issue → succeeds on the 2nd)", async () => {
    const llm = new FakeLlm({ texts: [NO_READY_HTML, GOOD_HTML] });
    const ctx = makeCtx(llm, { allowL2: true, routeTier: () => "L2" });
    const { spec, trace } = await compose(GUI_INPUT, ctx);

    expect(trace.tier).toBe("L2");
    expect(trace.attempts[0]!.issues!.join("\n")).toContain("L2_READY_MISSING");
    expect(spec.components.some((c) => c.type === SANDBOX_HTML_TYPE)).toBe(true);
  });

  it("once repairs are exhausted, falls to the deterministic fallback (from=L2)", async () => {
    const llm = new FakeLlm({ texts: [HALLUCINATED_HTML, HALLUCINATED_HTML] });
    const ctx = makeCtx(llm, { allowL2: true, routeTier: () => "L2" });
    const { spec, trace } = await compose(GUI_INPUT, ctx);

    // Aborted after the initial attempt + 1 repair (maxRepairAttempts default 1)
    expect(llm.calls).toHaveLength(2);
    expect(spec.provenance.fallback?.from).toBe("L2");
    expect(trace.fallback?.reason).toContain("L2 free-form generation failed");
  });

  it("the L2 LLM call is generateText + outputBudgetFactor=3 (long-output budget for full HTML)", async () => {
    const captured: unknown[] = [];
    const llm: LlmPort = {
      provider: "capture",
      modelId: "capture-model",
      async generateObject() {
        throw new Error("L2 does not use generateObject");
      },
      async generateText(req) {
        captured.push(req);
        return { text: GOOD_HTML, usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const ctx = makeCtx(llm, { allowL2: true, routeTier: () => "L2" });
    const { spec } = await compose(GUI_INPUT, ctx);

    expect(captured).toHaveLength(1);
    expect((captured[0] as { outputBudgetFactor?: number }).outputBudgetFactor).toBe(3);
    expect(spec.provenance.tier).toBe("L2");
  });

  it("promptParts (opt-in prompt-caching boundary): cacheable is the static L2 prompt (identical across repair attempts), rest is only the repair-feedback section, and cacheable+rest reconstructs prompt exactly", async () => {
    const captured: { prompt: string; promptParts?: { cacheable: string; rest: string } }[] = [];
    const llm: LlmPort = {
      provider: "capture",
      modelId: "capture-model",
      async generateObject() {
        throw new Error("L2 does not use generateObject");
      },
      async generateText(req) {
        captured.push({ prompt: req.prompt, promptParts: req.promptParts });
        return {
          text: captured.length === 1 ? HALLUCINATED_HTML : GOOD_HTML,
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    const ctx = makeCtx(llm, { allowL2: true, routeTier: () => "L2" });
    await compose(GUI_INPUT, ctx);

    expect(captured).toHaveLength(2);
    for (const c of captured) {
      expect(c.promptParts).toBeDefined();
      expect(c.promptParts!.cacheable + c.promptParts!.rest).toBe(c.prompt);
    }
    // The static (cacheable) part is identical between the initial attempt and the repair re-attempt;
    // only the trailing repair-feedback section (rest) differs.
    expect(captured[0]!.promptParts!.cacheable).toBe(captured[1]!.promptParts!.cacheable);
    expect(captured[0]!.promptParts!.rest).toBe("");
    expect(captured[1]!.promptParts!.rest).toContain("## Problems in the previous generation");
  });

  it("transient (ABORTED) is aborted in 1 attempt without a repair retry (the same discrimination as L1)", async () => {
    let calls = 0;
    const llm: LlmPort = {
      provider: "aborting",
      modelId: "aborting-model",
      async generateObject() {
        throw new Error("L2 does not use generateObject");
      },
      async generateText() {
        calls += 1;
        throw new LlmError("ABORTED", "aborted(test)");
      },
    };
    const ctx = makeCtx(llm, { allowL2: true, routeTier: () => "L2" });
    const { spec } = await compose(GUI_INPUT, ctx);

    expect(calls).toBe(1);
    expect(spec.provenance.fallback?.from).toBe("L2");
  });

  it("when l2Smoke returns issues, the repair loop runs and the passing 2nd is delivered", async () => {
    // The static lint passes both times (GOOD_HTML). The smoke returns NO_READY only on the first, and passes on the 2nd.
    const smokeIssue = "L2_SMOKE_NO_READY: window.kohaku.ready() was not called at runtime(smoke check)";
    let smokeCalls = 0;
    const l2Smoke = async (): Promise<string[]> => {
      smokeCalls += 1;
      return smokeCalls === 1 ? [smokeIssue] : [];
    };
    const llm = new FakeLlm({ texts: [GOOD_HTML, GOOD_HTML] });
    const ctx = makeCtx(llm, { allowL2: true, routeTier: () => "L2", l2Smoke });
    const { spec, trace } = await compose(GUI_INPUT, ctx);

    expect(smokeCalls).toBe(2);
    expect(llm.calls).toHaveLength(2);
    expect(trace.attempts[0]!.ok).toBe(false);
    expect(trace.attempts[0]!.issues!.join("\n")).toContain("L2_SMOKE_NO_READY");
    expect(trace.attempts[1]!.ok).toBe(true);
    // The smoke issue is sent back into the repair prompt (the same style as a static-lint failure)
    expect(llm.calls[1]!.prompt).toContain("L2_SMOKE_NO_READY");
    const sandbox = spec.components.find((c) => c.type === SANDBOX_HTML_TYPE);
    expect(sandbox!.artifact!.inline).toBe(GOOD_HTML);
  });

  it("when l2Smoke throws, the initial generation is delivered fail-open (a validator failure does not stop delivery)", async () => {
    let smokeCalls = 0;
    const l2Smoke = async (): Promise<string[]> => {
      smokeCalls += 1;
      throw new Error("smoke validator failure(test)");
    };
    const llm = new FakeLlm({ texts: [GOOD_HTML] });
    const ctx = makeCtx(llm, { allowL2: true, routeTier: () => "L2", l2Smoke });
    const { spec, trace } = await compose(GUI_INPUT, ctx);

    expect(smokeCalls).toBe(1);
    expect(llm.calls).toHaveLength(1);
    expect(trace.attempts[0]!.ok).toBe(true);
    const sandbox = spec.components.find((c) => c.type === SANDBOX_HTML_TYPE);
    expect(sandbox!.artifact!.inline).toBe(GOOD_HTML);
  });

  it("when l2Smoke is not wired, the initial generation is delivered in 1 attempt (behavior unchanged)", async () => {
    const llm = new FakeLlm({ texts: [GOOD_HTML] });
    const ctx = makeCtx(llm, { allowL2: true, routeTier: () => "L2" });
    const { spec, trace } = await compose(GUI_INPUT, ctx);

    expect(llm.calls).toHaveLength(1);
    expect(trace.attempts[0]!.ok).toBe(true);
    expect(spec.components.some((c) => c.type === SANDBOX_HTML_TYPE)).toBe(true);
  });

  it("repair retries are stopped by the budget guard (observable via budgetExceeded)", async () => {
    let checkCalls = 0;
    const check = (): { allow: boolean; reason?: string } => {
      checkCalls += 1;
      return checkCalls >= 2 ? { allow: false, reason: "L2 repair budget exceeded(test)" } : { allow: true };
    };
    const llm = new FakeLlm({ texts: [HALLUCINATED_HTML, GOOD_HTML] });
    const captured: ComposeErrorContext[] = [];
    const ctx: ComposeContext = {
      ...makeCtx(llm, { allowL2: true, routeTier: () => "L2", budget: { check } }),
      observer: {
        onError: (c) => {
          captured.push(c);
        },
      },
    };
    const { spec, trace } = await compose(GUI_INPUT, ctx);

    // check is called twice: before L2 (compose) and before repair (generateL2). The repair LLM call does not run.
    expect(checkCalls).toBe(2);
    expect(llm.calls).toHaveLength(1);
    expect(spec.provenance.fallback?.from).toBe("L2");
    expect(trace.fallback?.reason).toContain("budget exceeded");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.budgetExceeded).toBe(true);
  });
});

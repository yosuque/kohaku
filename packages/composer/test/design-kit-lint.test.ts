import { FakeLlm } from "@kohaku-ui/llm/fake";
import { type GuiAction, SANDBOX_HTML_TYPE } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type ComposeContext, compose, DEFAULT_KIT_VOCABULARY } from "../src/index.js";
import { collectL2Issues, collectUnknownKitClasses } from "../src/tiers/l2-generate.js";
import { catalog, makeSemantic, makeStorage } from "./helpers.js";

const GUI_INPUT: GuiAction = {
  kind: "gui",
  action: "facet.change",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
};

function makeCtx(llm: FakeLlm, policy: ComposeContext["policy"] = {}): ComposeContext {
  return { catalog, semantic: makeSemantic(), storage: makeStorage(), llm, policy };
}

function widget(body: string, script = ""): string {
  return [
    "<!DOCTYPE html><html><head><title>Sales widget</title>",
    "<style>.chart-container{width:100%}</style>",
    `</head><body>${body}<script>`,
    "async function main() {",
    '  const data = await window.kohaku.fetchData("query://sales/summary?fy=2026&groupBy=region&q=3");',
    script,
    "  window.kohaku.ready();",
    "}",
    "main();",
    "</script></body></html>",
  ].join("\n");
}

const KIT_HTML = widget(
  '<div class="k-card"><div class="k-card-title">Sales</div><div class="k-grid k-grid-3 gap-4"><div class="k-kpi"><span class="k-kpi-delta is-up">▲ 3%</span></div></div><table class="k-table"><tr><th class="k-num">Sales</th></tr></table><div class="chart-container grid-container"></div></div>',
  '  const el = document.createElement("div"); el.className = "k-notice k-notice-info mt-4"; el.classList.add("text-muted", "hidden");',
);

const UNKNOWN_HTML = widget(
  '<div class="k-panel p-4 text-gray-700"><span class="k-kpi-value">1</span></div>',
  '  const el = document.createElement("div"); el.className = "k-tile"; el.classList.add("rounded-xl");',
);

describe("collectUnknownKitClasses", () => {
  it("returns the sorted unique kit-namespaced classes that are not in the vocabulary (attributes, className, classList.add)", () => {
    expect(collectUnknownKitClasses(UNKNOWN_HTML, DEFAULT_KIT_VOCABULARY)).toEqual([
      "k-panel",
      "k-tile",
      "rounded-xl",
      "text-gray-700",
    ]);
  });

  it("ignores the model's own classes outside the kit namespaces and the is-up/is-down modifiers", () => {
    expect(collectUnknownKitClasses(KIT_HTML, DEFAULT_KIT_VOCABULARY)).toEqual([]);
  });

  it("ignores interpolated and concatenation-prefix class names", () => {
    const html = widget(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: guest-code source text under test; must stay a literal placeholder, not this file's own interpolation.
      '<div class="k-bar k-series-${i}"></div><div class="k-series-"></div>',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: guest-code source text under test; must stay a literal placeholder, not this file's own interpolation.
      "  el.className = `k-${kind}`;",
    );
    expect(collectUnknownKitClasses(html, DEFAULT_KIT_VOCABULARY)).toEqual([]);
  });

  it("still flags an invented series class", () => {
    expect(
      collectUnknownKitClasses(widget('<div class="k-series-9"></div>'), DEFAULT_KIT_VOCABULARY),
    ).toEqual(["k-series-9"]);
  });

  it('scans setAttribute("class", …) — SVG elements cannot use className', () => {
    const html = widget('<div class="k-card"></div>', '  rect.setAttribute("class", "k-axis k-tickz");');
    expect(collectUnknownKitClasses(html, DEFAULT_KIT_VOCABULARY)).toEqual(["k-tickz"]);
  });

  it("does not flag the now-covered spacing and sizing utilities", () => {
    expect(
      collectUnknownKitClasses(widget('<div class="mx-auto pt-2 h-full"></div>'), DEFAULT_KIT_VOCABULARY),
    ).toEqual([]);
  });
});

describe("collectL2Issues with a kit", () => {
  it("does nothing without a kit (behavior unchanged)", () => {
    expect(collectL2Issues(UNKNOWN_HTML)).toEqual([]);
    expect(collectL2Issues(UNKNOWN_HTML, { enforceTokenColors: true })).toEqual([]);
  });

  it("reports L2_UNKNOWN_CLASS listing the unknown names", () => {
    const issues = collectL2Issues(UNKNOWN_HTML, { kit: DEFAULT_KIT_VOCABULARY });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("L2_UNKNOWN_CLASS");
    expect(issues[0]).toContain("k-panel, k-tile, rounded-xl, text-gray-700");
  });

  it("passes a kit-compliant widget", () => {
    expect(collectL2Issues(KIT_HTML, { kit: DEFAULT_KIT_VOCABULARY })).toEqual([]);
  });
});

describe("compose wiring (designSystem.kit → lint → repair)", () => {
  const KIT_POLICY: ComposeContext["policy"] = {
    allowL2: true,
    routeTier: () => "L2",
    designSystem: { kit: DEFAULT_KIT_VOCABULARY },
  };

  it("an unknown-class first output is sent back and the compliant second output is delivered", async () => {
    const llm = new FakeLlm({ texts: [UNKNOWN_HTML, KIT_HTML] });
    const { spec, trace } = await compose(GUI_INPUT, makeCtx(llm, KIT_POLICY));
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0]!.prompt).toContain("## Design kit (kohaku v1)");
    expect(trace.attempts[0]!.issues!.join("\n")).toContain("L2_UNKNOWN_CLASS");
    expect(llm.calls[1]!.prompt).toContain("L2_UNKNOWN_CLASS");
    const sandbox = spec.components.find((c) => c.type === SANDBOX_HTML_TYPE);
    expect(sandbox!.artifact!.inline).toBe(KIT_HTML);
  });

  it("enforceKitClasses: false keeps the prompt section but delivers unknown classes (safety valve)", async () => {
    const llm = new FakeLlm({ texts: [UNKNOWN_HTML] });
    const { spec } = await compose(
      GUI_INPUT,
      makeCtx(llm, {
        ...KIT_POLICY,
        designSystem: { kit: DEFAULT_KIT_VOCABULARY, enforceKitClasses: false },
      }),
    );
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.prompt).toContain("## Design kit (kohaku v1)");
    const sandbox = spec.components.find((c) => c.type === SANDBOX_HTML_TYPE);
    expect(sandbox!.artifact!.inline).toBe(UNKNOWN_HTML);
  });
});

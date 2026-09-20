import { describe, expect, it } from "vitest";
import {
  DEFAULT_KIT_SKELETON,
  DEFAULT_KIT_VOCABULARY,
  designKitPromptFragment,
  L2_SYSTEM_PROMPT,
} from "../src/index.js";
import { buildL2Prompt } from "../src/prompt.js";

/**
 * Cross-language golden of the "Design kit" section (the Python test_design_kit.py pins the identical
 * string). Change both together and bump PROMPT_REVISION.
 */
export const EXPECTED_KIT_FRAGMENT = [
  "## Design kit (kohaku v1)",
  "- The host injects a base stylesheet: body already has the font, text color, background and line-height; headings are scaled; :focus-visible rings are provided. Do not restate these",
  "- Prefer the component classes below for common blocks; use the utilities for layout and spacing; write custom CSS only for what they do not cover, and then only with var(--kohaku-*) tokens",
  "- Component classes:",
  "  - k-card: surface container (border, large radius, subtle shadow, padding); put k-card-title first inside it",
  "  - k-card-title: title row of a k-card",
  "  - k-title: section title text",
  "  - k-subtitle: small muted text under a title",
  "  - k-muted: muted (secondary) text color",
  "  - k-num: numeric cell/text — tabular figures, right-aligned",
  "  - k-kpi: a KPI block; children k-kpi-label, k-kpi-value, k-kpi-delta",
  "  - k-kpi-label: small muted label above a KPI value",
  "  - k-kpi-value: the large KPI number",
  "  - k-kpi-delta: change indicator; add is-up or is-down for the color and keep a ▲/▼ symbol in the text",
  "  - k-btn: button base; combine with k-btn-primary, k-btn-secondary or k-btn-danger",
  "  - k-btn-primary: filled brand-color button",
  "  - k-btn-secondary: outline button",
  "  - k-btn-danger: filled danger button",
  "  - k-table: data table (muted header row, row dividers, hover); add k-num to numeric th/td",
  "  - k-badge: small pill; add k-badge-positive / k-badge-negative / k-badge-warning / k-badge-info for tone",
  "  - k-badge-positive: success tone badge",
  "  - k-badge-negative: error/decline tone badge",
  "  - k-badge-warning: warning tone badge",
  "  - k-badge-info: info tone badge",
  "  - k-notice: inline notice box for empty / error / loading states; add k-notice-positive / k-notice-negative / k-notice-warning / k-notice-info for tone",
  "  - k-notice-positive: success notice",
  "  - k-notice-negative: error notice",
  "  - k-notice-warning: warning notice",
  "  - k-notice-info: info notice",
  "  - k-stack: vertical flex column with medium gap",
  "  - k-row: horizontal flex row, centered, wrapping, small gap",
  "  - k-grid: responsive auto-fit grid; add k-grid-2 / k-grid-3 / k-grid-4 for a fixed column count (collapses to one column on narrow widths)",
  "  - k-grid-2: two equal columns",
  "  - k-grid-3: three equal columns",
  "  - k-grid-4: four equal columns",
  "  - k-label: form field label",
  "  - k-input: text input",
  "  - k-select: select control",
  "  - k-chart: put on the <svg> root (width 100%, fixed viewBox); the chart classes below (k-axis … k-line) apply only to elements inside it",
  "  - k-axis: axis line (<line>/<path>)",
  "  - k-gridline: dashed horizontal grid line",
  "  - k-tick: tick label (<text>)",
  "  - k-axis-label: axis title (<text>)",
  "  - k-series-1: series color 1 (fill and stroke); k-series-2 … k-series-7 likewise",
  "  - k-series-2: series color 2",
  "  - k-series-3: series color 3",
  "  - k-series-4: series color 4",
  "  - k-series-5: series color 5",
  "  - k-series-6: series color 6",
  "  - k-series-7: series color 7",
  "  - k-bar: bar rect (rounded corners)",
  "  - k-line: line-chart path (no fill, 2px stroke)",
  "- Utilities (exactly these names exist; any other utility name has no effect): flex, grid, hidden, w-full, flex-col, flex-wrap, items-center, items-start, justify-between, justify-end, grid-cols-2, grid-cols-3, grid-cols-4, gap-1, gap-2, gap-3, gap-4, gap-5, gap-6, p-1, p-2, p-3, p-4, p-5, p-6, px-1, px-2, px-3, px-4, px-5, px-6, py-1, py-2, py-3, py-4, py-5, py-6, m-0, mt-1, mt-2, mt-3, mt-4, mt-5, mt-6, mb-1, mb-2, mb-3, mb-4, mb-5, mb-6, text-xs, text-sm, text-md, text-lg, text-xl, text-2xl, text-muted, text-primary, text-positive, text-negative, text-left, text-center, text-right, truncate, tabular-nums, font-medium, font-semibold, font-bold, rounded-sm, rounded-md, rounded-lg, rounded-full, shadow-sm, shadow-md, border, border-b, bg-surface, bg-background",
  "- Reserved prefixes (kit namespace; never use them for your own class names — pick names like chart-…, panel-…): k-, gap-, p-, px-, py-, pt-, pb-, pl-, pr-, m-, mx-, my-, mt-, mb-, ml-, mr-, text-, font-, rounded-, shadow-, bg-, grid-cols-, items-, justify-, flex-, border-, w-, h-",
  "- Skeleton of a well-formed widget body (adapt it; do not copy verbatim):",
  '  <div class="k-card">',
  '    <div class="k-card-title">Sales by region</div>',
  '    <div class="k-grid k-grid-3 mb-4">',
  '      <div class="k-kpi"><span class="k-kpi-label">Total</span><span class="k-kpi-value">1,234</span><span class="k-kpi-delta is-up">▲ +12%</span></div>',
  "    </div>",
  '    <table class="k-table">',
  '      <thead><tr><th>Region</th><th class="k-num">Sales</th></tr></thead>',
  '      <tbody><tr><td>East</td><td class="k-num">1,234</td></tr></tbody>',
  "    </table>",
  '    <div class="k-notice k-notice-info mt-4 hidden" id="empty">No data for this period</div>',
  "  </div>",
].join("\n");

describe("DEFAULT_KIT_VOCABULARY", () => {
  it("is versioned like renderer-core's defaultDesignKit and lists namespaces for the lint", () => {
    expect(DEFAULT_KIT_VOCABULARY.id).toBe("kohaku");
    expect(DEFAULT_KIT_VOCABULARY.version).toBe("1");
    expect(DEFAULT_KIT_VOCABULARY.namespaces).toContain("k-");
    expect(DEFAULT_KIT_VOCABULARY.namespaces).toContain("gap-");
    expect(DEFAULT_KIT_VOCABULARY.utilities).toContain("grid-cols-3");
    expect(Object.keys(DEFAULT_KIT_VOCABULARY.classes)).toContain("k-card");
  });

  it("the skeleton uses only vocabulary classes and is a body fragment (no <html>, no <script>)", () => {
    const known = new Set([
      ...Object.keys(DEFAULT_KIT_VOCABULARY.classes),
      ...DEFAULT_KIT_VOCABULARY.utilities,
      "is-up",
      "is-down",
    ]);
    for (const m of DEFAULT_KIT_SKELETON.matchAll(/class="([^"]*)"/g)) {
      for (const cls of m[1]!.split(/\s+/).filter((c) => c !== "")) expect(known.has(cls), cls).toBe(true);
    }
    expect(DEFAULT_KIT_SKELETON).not.toContain("<html");
    expect(DEFAULT_KIT_SKELETON).not.toContain("<script");
  });
});

describe("designKitPromptFragment", () => {
  it("emits the cross-language golden", () => {
    expect(designKitPromptFragment(DEFAULT_KIT_VOCABULARY)).toBe(EXPECTED_KIT_FRAGMENT);
  });

  it("a custom kit is rendered with its own id/version, classes in insertion order, and an optional skeleton", () => {
    const fragment = designKitPromptFragment({
      id: "acme",
      version: "3",
      classes: { "k-tile": "tile" },
      utilities: ["flex"],
      namespaces: ["k-"],
      skeleton: '<div class="k-tile">x</div>',
    });
    expect(fragment.split("\n")[0]).toBe("## Design kit (acme v3)");
    expect(fragment).toContain("  - k-tile: tile");
    expect(fragment).toContain(
      "- Utilities (exactly these names exist; any other utility name has no effect): flex",
    );
    // Custom skeleton replaces the default one, indented the same way.
    expect(fragment).toContain('  <div class="k-tile">x</div>');
    expect(fragment).not.toContain("Sales by region");
  });
});

describe("L2 prompt integration", () => {
  const args = {
    intent: { canonical: "sales.custom", params: { request: "test" }, hash: "sha256:" + "0".repeat(64) },
    refs: ["query://sales/custom"],
    shapesByRef: new Map(),
  };

  it("the system prompt ends with the design brief instead of the old 'simple and readable' line", () => {
    expect(L2_SYSTEM_PROMPT).not.toContain("Keep the design simple and readable");
    expect(L2_SYSTEM_PROMPT).toContain("- Design brief (follow every point):");
    expect(L2_SYSTEM_PROMPT.split("\n").at(-1)).toBe(
      "  - never leave browser-default styling on tables, buttons or inputs",
    );
  });

  it("without a kit the Design kit section is absent; with a kit it follows the design-system section", () => {
    expect(buildL2Prompt({ ...args, designSystem: {} })).not.toContain("## Design kit");
    const prompt = buildL2Prompt({ ...args, designSystem: { kit: DEFAULT_KIT_VOCABULARY } });
    const dsAt = prompt.indexOf("## Design system");
    const kitAt = prompt.indexOf("## Design kit");
    expect(kitAt).toBeGreaterThan(dsAt);
    expect(kitAt).toBeLessThan(prompt.indexOf("## Output language"));
    expect(prompt).toContain(EXPECTED_KIT_FRAGMENT);
  });
});

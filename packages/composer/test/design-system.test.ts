import { FakeLlm } from "@kohaku-ui/llm/fake";
import { type GuiAction, SANDBOX_HTML_TYPE } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import {
  type ComposeContext,
  compose,
  type DesignSystemGuide,
  designSystemPromptFragment,
  tokenToCssVar,
} from "../src/index.js";
import { buildL2Prompt } from "../src/prompt.js";
import { collectL2Issues } from "../src/tiers/l2-generate.js";
import { catalog, makeSemantic, makeStorage } from "./helpers.js";

const GUI_INPUT: GuiAction = {
  kind: "gui",
  action: "facet.change",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
};

function makeCtx(llm: FakeLlm, policy: ComposeContext["policy"] = {}): ComposeContext {
  return { catalog, semantic: makeSemantic(), storage: makeStorage(), llm, policy };
}

/** A passing output whose styles are written with token references only (bridge contract + design-system compliant). */
const TOKEN_HTML = [
  "<!DOCTYPE html><html><head><title>Sales widget</title>",
  "<style>body{background:var(--kohaku-color-background);color:var(--kohaku-color-text);}</style>",
  '</head><body><div id="app"></div><script>',
  "async function main() {",
  '  const data = await window.kohaku.fetchData("query://sales/summary?fy=2026&groupBy=region&q=3");',
  '  document.getElementById("app").textContent = JSON.stringify(data.rows);',
  "  window.kohaku.ready();",
  "}",
  "main();",
  "</script></body></html>",
].join("\n");

/** An output with raw color values (sent back with L2_RAW_COLOR when a design system is applied). */
const RAW_COLOR_HTML = TOKEN_HTML.replace(
  "background:var(--kohaku-color-background);color:var(--kohaku-color-text);",
  "background:#ffffff;color:rgb(26, 26, 46);",
);

const GUIDE: DesignSystemGuide = {
  tokens: { "color.primary": "brand color (override)", "brand.accent": "accent color" },
  guidelines: ["Corner radius is 8px", "Spacing in multiples of 4px"],
};

/**
 * The expected value of the design-system section (cross-language contract). The Python-side
 * test_design_system.py has the identical expected string, and both language implementations matching this
 * form guarantees character-level prompt compatibility.
 * When changing it, update both tests simultaneously (a prompt change = do not forget the PROMPT_REVISION bump either).
 */
const EXPECTED_FRAGMENT = [
  "## Design system (must be followed)",
  "- Always specify colors with CSS custom properties (design tokens). Hard-coding #hex, rgb(), hsl(), or color names is forbidden (the host injects the token values, adapting automatically to both light and dark themes)",
  "- Default the background to var(--kohaku-color-background) and the text color to var(--kohaku-color-text)",
  "- Available tokens:",
  "  - var(--kohaku-color-background): page/root background",
  "  - var(--kohaku-color-surface): surface of cards, panels, and table headers",
  "  - var(--kohaku-color-border): borders and separators",
  "  - var(--kohaku-color-text): text color for headings and body",
  "  - var(--kohaku-color-muted): secondary text, captions, axis labels",
  "  - var(--kohaku-color-on-primary): foreground on primary/negative fills (button text etc.)",
  "  - var(--kohaku-color-primary): brand color (override)",
  "  - var(--kohaku-color-positive): emphasis color for increase, rise, success",
  "  - var(--kohaku-color-positive-surface): background surface of success notices",
  "  - var(--kohaku-color-positive-text): text color of success notices",
  "  - var(--kohaku-color-positive-border): border of success notices",
  "  - var(--kohaku-color-negative): emphasis color for decrease, decline, danger",
  "  - var(--kohaku-color-negative-surface): background surface of error notices",
  "  - var(--kohaku-color-negative-text): text color of error notices",
  "  - var(--kohaku-color-negative-border): border of error notices",
  "  - var(--kohaku-color-warning-surface): background surface of warning notices",
  "  - var(--kohaku-color-warning-text): text color of warning notices",
  "  - var(--kohaku-color-info-surface): background surface of info notices",
  "  - var(--kohaku-color-info-text): text color of info notices",
  "  - var(--kohaku-color-info-border): border of info notices",
  "  - var(--kohaku-chart-axis): chart axis lines, ticks, grid lines",
  "  - var(--kohaku-chart-palette-1) … var(--kohaku-chart-palette-7): chart series colors (use from 1 upward)",
  "  - var(--kohaku-brand-accent): accent color",
  "- Additional style rules:",
  "  - Corner radius is 8px",
  "  - Spacing in multiples of 4px",
].join("\n");

describe("designSystemPromptFragment (design-system section)", () => {
  it("emits default vocabulary + overrides + custom tokens + rules as the expected string (cross-language contract golden)", () => {
    expect(designSystemPromptFragment(GUIDE)).toBe(EXPECTED_FRAGMENT);
  });

  it("even with an empty guide, the default vocabulary and palette guidance are always included (no rules section)", () => {
    const fragment = designSystemPromptFragment({});
    expect(fragment).toContain("var(--kohaku-color-primary)");
    expect(fragment).toContain("var(--kohaku-chart-palette-1)");
    expect(fragment).not.toContain("Additional style rules");
  });

  it("tokenToCssVar replaces . in the token name with - and prepends the --kohaku- prefix", () => {
    expect(tokenToCssVar("color.positive.surface")).toBe("--kohaku-color-positive-surface");
  });
});

describe("insertion of the design-system section into buildL2Prompt", () => {
  const args = {
    intent: {
      canonical: "sales.custom",
      params: { request: "test" },
      hash: "sha256:" + "0".repeat(64),
    },
    refs: ["query://sales/custom"],
    shapesByRef: new Map(),
  };

  it("when designSystem is unspecified, the output is byte-for-byte identical to before (no section inserted)", () => {
    expect(buildL2Prompt(args)).not.toContain("## Design system");
  });

  it("with designSystem specified, the section goes after the data shape and before the instructions", () => {
    const prompt = buildL2Prompt({ ...args, designSystem: GUIDE });
    const dsAt = prompt.indexOf("## Design system");
    expect(dsAt).toBeGreaterThan(prompt.indexOf("## Data shape"));
    expect(dsAt).toBeLessThan(prompt.indexOf("## Instructions"));
    expect(prompt).toContain(EXPECTED_FRAGMENT);
  });
});

describe("collectL2Issues raw-color check (L2_RAW_COLOR)", () => {
  it("with enforceTokenColors disabled (default), raw colors are not flagged even if present (behavior unchanged)", () => {
    expect(collectL2Issues(RAW_COLOR_HTML)).toEqual([]);
    expect(collectL2Issues(RAW_COLOR_HTML, { enforceTokenColors: false })).toEqual([]);
  });

  it("detects raw hex as L2_RAW_COLOR", () => {
    const issues = collectL2Issues(RAW_COLOR_HTML, { enforceTokenColors: true });
    expect(issues.some((i) => i.startsWith("L2_RAW_COLOR"))).toBe(true);
  });

  it("also detects rgb() / hsl()", () => {
    const rgb = TOKEN_HTML.replace("var(--kohaku-color-text)", "rgba(0, 0, 0, 0.8)");
    expect(collectL2Issues(rgb, { enforceTokenColors: true }).some((i) => i.startsWith("L2_RAW_COLOR"))).toBe(
      true,
    );
    const hsl = TOKEN_HTML.replace("var(--kohaku-color-text)", "hsl(220, 10%, 20%)");
    expect(collectL2Issues(hsl, { enforceTokenColors: true }).some((i) => i.startsWith("L2_RAW_COLOR"))).toBe(
      true,
    );
  });

  it("an output using only token references var(--kohaku-*) passes", () => {
    expect(collectL2Issues(TOKEN_HTML, { enforceTokenColors: true })).toEqual([]);
  });

  it("CSS id selectors (#chart etc.) are not mis-detected as hex", () => {
    const html = TOKEN_HTML.replace("body{", "#chart{padding:8px;} .bar:hover{opacity:0.8;} body{");
    expect(collectL2Issues(html, { enforceTokenColors: true })).toEqual([]);
  });
});

describe("L2 generation with design-system applied (repair loop / E2E)", () => {
  const DS_POLICY: ComposeContext["policy"] = {
    allowL2: true,
    routeTier: () => "L2",
    designSystem: GUIDE,
  };

  it("the design-system section is included in the generation prompt", async () => {
    const llm = new FakeLlm({ texts: [TOKEN_HTML] });
    const { spec } = await compose(GUI_INPUT, makeCtx(llm, DS_POLICY));
    expect(llm.calls[0]!.prompt).toContain("## Design system (must be followed)");
    expect(llm.calls[0]!.prompt).toContain("Corner radius is 8px");
    const sandbox = spec.components.find((c) => c.type === SANDBOX_HTML_TYPE);
    expect(sandbox!.artifact!.inline).toContain("var(--kohaku-color-background)");
  });

  it("a raw-color initial generation is sent back with L2_RAW_COLOR, and the token-compliant 2nd is delivered", async () => {
    const llm = new FakeLlm({ texts: [RAW_COLOR_HTML, TOKEN_HTML] });
    const { spec, trace } = await compose(GUI_INPUT, makeCtx(llm, DS_POLICY));

    expect(llm.calls).toHaveLength(2);
    expect(trace.attempts[0]!.ok).toBe(false);
    expect(trace.attempts[0]!.issues!.join("\n")).toContain("L2_RAW_COLOR");
    expect(llm.calls[1]!.prompt).toContain("L2_RAW_COLOR");
    const sandbox = spec.components.find((c) => c.type === SANDBOX_HTML_TYPE);
    expect(sandbox!.artifact!.inline).toBe(TOKEN_HTML);
  });

  it("with enforceTokenColors: false, raw colors are not sent back (safety valve)", async () => {
    const llm = new FakeLlm({ texts: [RAW_COLOR_HTML] });
    const { spec, trace } = await compose(
      GUI_INPUT,
      makeCtx(llm, { ...DS_POLICY, designSystem: { ...GUIDE, enforceTokenColors: false } }),
    );
    expect(llm.calls).toHaveLength(1);
    // The prompt instruction (section) remains
    expect(llm.calls[0]!.prompt).toContain("## Design system (must be followed)");
    expect(trace.attempts[0]!.ok).toBe(true);
    const sandbox = spec.components.find((c) => c.type === SANDBOX_HTML_TYPE);
    expect(sandbox!.artifact!.inline).toBe(RAW_COLOR_HTML);
  });

  it("compose without designSystem delivers even with raw colors and leaves the prompt unchanged", async () => {
    const llm = new FakeLlm({ texts: [RAW_COLOR_HTML] });
    const { spec } = await compose(GUI_INPUT, makeCtx(llm, { allowL2: true, routeTier: () => "L2" }));
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.prompt).not.toContain("## Design system");
    expect(spec.components.some((c) => c.type === SANDBOX_HTML_TYPE)).toBe(true);
  });
});

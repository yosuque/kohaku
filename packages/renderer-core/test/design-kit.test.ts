import { describe, expect, it } from "vitest";
import { defaultDesignKit, PARTS_STATE_CSS } from "../src/index.js";

const RAW_COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/;

describe("defaultDesignKit", () => {
  it("is versioned and carries the kit CSS", () => {
    expect(defaultDesignKit.id).toBe("kohaku");
    expect(defaultDesignKit.version).toBe("1");
    expect(defaultDesignKit.css.length).toBeGreaterThan(2000);
  });

  it("holds no raw colour values (every colour is a var(--kohaku-color-*) reference or currentColor)", () => {
    expect(RAW_COLOR_RE.test(defaultDesignKit.css)).toBe(false);
    expect(defaultDesignKit.css).toContain("var(--kohaku-color-surface)");
    expect(defaultDesignKit.css).toContain("var(--kohaku-radius-lg)");
    expect(defaultDesignKit.css).toContain("var(--kohaku-font-family-sans)");
  });

  it("defines the base, the component classes, the chart classes and the utilities", () => {
    for (const selector of [
      "body{",
      ":focus-visible{",
      ".k-card{",
      ".k-kpi-value{",
      ".k-btn-primary{",
      ".k-table th{",
      ".k-badge-positive{",
      ".k-notice-negative{",
      ".k-grid-3{",
      ".k-chart .k-axis{",
      ".k-chart .k-series-7{",
      ".gap-4{",
      ".rounded-lg{",
      ".text-muted{",
      ".grid-cols-3{",
    ]) {
      expect(defaultDesignKit.css).toContain(selector);
    }
  });

  it("keeps UA margins on headings/paragraphs and leaves bare tables alone (only box-sizing and html/body margin are reset)", () => {
    expect(defaultDesignKit.css).not.toContain("p{margin:0}");
    expect(defaultDesignKit.css).not.toMatch(/h1,h2,h3,h4\{[^}]*margin:0/);
    expect(defaultDesignKit.css).not.toMatch(/(^|})table\{/);
    expect(defaultDesignKit.css).toContain("*,*::before,*::after{box-sizing:border-box}");
  });

  it("cannot break out of the trusted <style> element", () => {
    expect(defaultDesignKit.css).not.toContain("</");
  });
});

describe("k-grid-N / grid-cols-N (m-11, m-12)", () => {
  it("k-grid-2/3/4 each declare display:grid and a gap on their own rule (self-sufficient without .k-grid)", () => {
    for (const n of [2, 3, 4]) {
      const match = defaultDesignKit.css.match(new RegExp(`\\.k-grid-${n}\\{([^}]*)\\}`));
      expect(match, `.k-grid-${n} rule not found`).not.toBeNull();
      const body = match![1]!;
      expect(body).toContain("display:grid");
      expect(body).toMatch(/gap:var\(--kohaku-space-\d\)/);
    }
  });

  it('grid-cols-2/3/4 fold to one column at the same 480px breakpoint as k-grid-2/3/4 (the two spellings behave identically together, e.g. "k-grid k-grid-2 grid-cols-2")', () => {
    expect(defaultDesignKit.css).toContain(
      "@media (max-width:480px){.k-grid-2,.k-grid-3,.k-grid-4{grid-template-columns:1fr}}",
    );
    expect(defaultDesignKit.css).toContain(
      "@media (max-width:480px){.grid-cols-2,.grid-cols-3,.grid-cols-4{grid-template-columns:1fr}}",
    );
  });
});

describe("PARTS_STATE_CSS (theme-neutral L1 state styles)", () => {
  it("scopes every selector to a kohaku subtree and holds no color values", () => {
    const rules = PARTS_STATE_CSS.split("}").filter((r) => r.trim() !== "");
    for (const rule of rules) {
      const selectors = rule.slice(0, rule.indexOf("{")).split(",");
      for (const selector of selectors) {
        expect(selector.trim(), selector).toMatch(/^\[data-kohaku\]|^[a-z]+\[data-kohaku\]/);
      }
    }
    expect(RAW_COLOR_RE.test(PARTS_STATE_CSS)).toBe(false);
    expect(PARTS_STATE_CSS).not.toContain("var(--kohaku");
    expect(PARTS_STATE_CSS).not.toContain("</");
    expect(PARTS_STATE_CSS).toContain(":hover");
    expect(PARTS_STATE_CSS).toContain(":focus-visible");
  });
});

/**
 * A structural parser for the kit CSS — deliberately not a CSS engine, just enough string-walking to
 * catch what nothing else in the repo notices: a dropped or doubled brace, a rule with no declarations,
 * or a declaration that lost its colon. The existing tests above only ever check that a substring is
 * present or absent; none of them would fail if a `}` went missing anywhere in the file.
 *
 * Both kit CSS strings have exactly the shape: a flat concatenation of "selector{declarations}" rules
 * (declarations `;`-separated, no trailing `;`), plus — in defaultDesignKit.css only — a small, fixed
 * number of `@media (max-width:480px){ nested-rule{...} }` wrappers, each around one nested rule (m-12
 * added a second such wrapper alongside the pre-existing .k-grid-2/3/4 breakpoint, for .grid-cols-2/3/4).
 * Each wrapper is located and unwrapped explicitly below; this is not a general at-rule parser.
 */
interface ParsedCssRule {
  selector: string;
  declarations: string[];
}

interface ParsedCss {
  openBraceCount: number;
  closeBraceCount: number;
  rules: ParsedCssRule[];
  /** Index of every place in the source where two "}" occur back to back. */
  doubleBraceIndices: number[];
  /** The indices among those that are legitimate (each @media block's own close). */
  expectedDoubleBraceIndices: number[];
}

/** One `@media (...){ nested-rule{...} }` wrapper's boundaries, located against the original CSS text. */
interface MediaBlock {
  /** Index of the "@" that starts the block. */
  start: number;
  /** Index right after the prelude's own "{". */
  preludeEnd: number;
  /** Index of the first "}" of the block's closing "}}" (the nested rule's own close). */
  close: number;
}

function findMediaBlocks(css: string): MediaBlock[] {
  const blocks: MediaBlock[] = [];
  for (const m of css.matchAll(/@media[^{]*\{/g)) {
    if (m.index === undefined) continue;
    const preludeEnd = m.index + m[0].length;
    const close = css.indexOf("}}", preludeEnd);
    if (close !== -1) blocks.push({ start: m.index, preludeEnd, close });
  }
  return blocks;
}

function parseKitCss(css: string): ParsedCss {
  const openBraceCount = (css.match(/\{/g) ?? []).length;
  const closeBraceCount = (css.match(/\}/g) ?? []).length;

  const doubleBraceIndices: number[] = [];
  for (let i = 0; i < css.length - 1; i++) {
    if (css[i] === "}" && css[i + 1] === "}") doubleBraceIndices.push(i);
  }

  // Unwrap every @media block: strip its "@media (...){" prelude and one of the two closing braces that
  // follow it, leaving the nested rule in place as an ordinary "selector{...}" rule. Blocks are located
  // once against the ORIGINAL css (so their indices line up with doubleBraceIndices above), then applied
  // to `flat` right-to-left so an earlier (more-to-the-left) block's indices stay valid in `flat` while a
  // later one is removed first.
  const mediaBlocks = findMediaBlocks(css);
  const expectedDoubleBraceIndices = mediaBlocks.map((b) => b.close);
  let flat = css;
  for (const block of [...mediaBlocks].reverse()) {
    flat =
      flat.slice(0, block.start) +
      flat.slice(block.preludeEnd, block.close + 1) +
      flat.slice(block.close + 2);
  }

  // What remains is a plain sequence of "selector{declarations}" rules with nothing between them, so
  // splitting on "}" yields exactly one chunk per rule, plus a trailing "" for the string's own close.
  const chunks = flat.split("}");
  if (chunks[chunks.length - 1] === "") chunks.pop();

  const rules: ParsedCssRule[] = chunks.map((chunk) => {
    const braceIndex = chunk.indexOf("{");
    const selector = (braceIndex === -1 ? chunk : chunk.slice(0, braceIndex)).trim();
    const body = braceIndex === -1 ? "" : chunk.slice(braceIndex + 1);
    const declarations = body.trim() === "" ? [] : body.split(";").map((d) => d.trim());
    return { selector, declarations };
  });

  return { openBraceCount, closeBraceCount, rules, doubleBraceIndices, expectedDoubleBraceIndices };
}

/** Runs every structural check below against one parsed CSS string, with a minimum rule-count floor. */
function assertWellFormedCss(css: string, minRuleCount: number): void {
  const parsed = parseKitCss(css);

  expect(parsed.openBraceCount, "brace count: { vs }").toBe(parsed.closeBraceCount);

  for (const rule of parsed.rules) {
    expect(rule.declarations.length, `rule "${rule.selector}" has no declarations`).toBeGreaterThanOrEqual(1);
    for (const decl of rule.declarations) {
      expect(
        decl.length > 0 && decl.includes(":"),
        `rule "${rule.selector}": empty or colon-less declaration "${decl}"`,
      ).toBe(true);
    }
  }

  const strayDoubleBraces = parsed.doubleBraceIndices.filter(
    (i) => !parsed.expectedDoubleBraceIndices.includes(i),
  );
  expect(strayDoubleBraces, '"}}" found outside an @media block, at these indices').toEqual([]);

  expect(parsed.rules.length, "rule count").toBeGreaterThanOrEqual(minRuleCount);
}

describe("kit CSS structural parser", () => {
  it("defaultDesignKit.css is a well-formed sequence of balanced rules (>= 140 of them)", () => {
    // Measured at HEAD: 202 rules (204 "{" including the two @media preludes), 358 declarations, 13500 chars.
    assertWellFormedCss(defaultDesignKit.css, 140);
  });

  it("PARTS_STATE_CSS is a well-formed sequence of balanced rules (>= 4 of them)", () => {
    // Measured at HEAD: exactly 4 rules, 5 declarations, 416 chars, no @media block.
    assertWellFormedCss(PARTS_STATE_CSS, 4);
  });
});

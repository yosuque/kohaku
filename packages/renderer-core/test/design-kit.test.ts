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
 * (declarations `;`-separated, no trailing `;`), plus — in defaultDesignKit.css only — a single
 * `@media (max-width:480px){ nested-rule{...} }` wrapper around one nested rule. That one wrapper is
 * unwrapped explicitly below; this is not a general at-rule parser.
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
  /** The one such index that is legitimate (the @media block's own close), or null if there is none. */
  expectedDoubleBraceIndex: number | null;
}

function parseKitCss(css: string): ParsedCss {
  const openBraceCount = (css.match(/\{/g) ?? []).length;
  const closeBraceCount = (css.match(/\}/g) ?? []).length;

  const doubleBraceIndices: number[] = [];
  for (let i = 0; i < css.length - 1; i++) {
    if (css[i] === "}" && css[i + 1] === "}") doubleBraceIndices.push(i);
  }

  // Unwrap the single @media block (if present): strip its "@media (...){" prelude and one of the two
  // closing braces that follow it, leaving the nested rule in place as an ordinary "selector{...}" rule.
  let flat = css;
  let expectedDoubleBraceIndex: number | null = null;
  const mediaMatch = css.match(/@media[^{]*\{/);
  if (mediaMatch?.index !== undefined) {
    const preludeEnd = mediaMatch.index + mediaMatch[0].length;
    const mediaClose = css.indexOf("}}", preludeEnd);
    if (mediaClose !== -1) {
      expectedDoubleBraceIndex = mediaClose;
      flat =
        css.slice(0, mediaMatch.index) + css.slice(preludeEnd, mediaClose + 1) + css.slice(mediaClose + 2);
    }
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

  return { openBraceCount, closeBraceCount, rules, doubleBraceIndices, expectedDoubleBraceIndex };
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

  const strayDoubleBraces = parsed.doubleBraceIndices.filter((i) => i !== parsed.expectedDoubleBraceIndex);
  expect(strayDoubleBraces, '"}}" found outside the @media block, at these indices').toEqual([]);

  expect(parsed.rules.length, "rule count").toBeGreaterThanOrEqual(minRuleCount);
}

describe("kit CSS structural parser", () => {
  it("defaultDesignKit.css is a well-formed sequence of balanced rules (>= 140 of them)", () => {
    // Measured at HEAD: 145 rules (146 "{" including the @media prelude), 282 declarations, 10642 chars.
    assertWellFormedCss(defaultDesignKit.css, 140);
  });

  it("PARTS_STATE_CSS is a well-formed sequence of balanced rules (>= 4 of them)", () => {
    // Measured at HEAD: exactly 4 rules, 5 declarations, 416 chars, no @media block.
    assertWellFormedCss(PARTS_STATE_CSS, 4);
  });
});

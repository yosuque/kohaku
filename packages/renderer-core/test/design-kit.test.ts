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

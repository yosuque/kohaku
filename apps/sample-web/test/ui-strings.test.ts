import { describe, expect, it } from "vitest";
import { UI, type UIStrings } from "../src/i18n/ui.js";

// The UIStrings interface already forces EN/JA key parity at compile time; this test catches what
// the type system cannot — placeholder values (empty strings / empty arrays) left in either language.

function walk(value: unknown, path: string, visit: (path: string, leaf: string) => void): void {
  if (typeof value === "string") {
    visit(path, value);
    return;
  }
  if (Array.isArray(value)) {
    expect(value.length, `${path} must not be empty`).toBeGreaterThan(0);
    value.forEach((v, i) => {
      walk(v, `${path}[${i}]`, visit);
    });
    return;
  }
  if (typeof value === "function") {
    // Parameterized messages: probe with representative args and check the result is non-empty.
    const fn = value as (...args: unknown[]) => string;
    const probed = fn("x", "y", "z");
    expect(typeof probed, `${path}(…) must return a string`).toBe("string");
    expect(probed.trim(), `${path}(…) must not be empty`).not.toBe("");
    return;
  }
  if (value != null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`, visit);
  }
}

describe("ui.ts dictionary", () => {
  it.each(["en", "ja"] as const)("%s has no empty strings", (lang) => {
    walk(UI[lang], lang, (path, leaf) => {
      expect(leaf.trim(), `${path} must not be empty`).not.toBe("");
    });
  });

  it("en and ja have identical key structure (deep walk)", () => {
    const shape = (value: unknown): unknown => {
      if (typeof value === "string" || typeof value === "function") return "leaf";
      if (Array.isArray(value)) return "leaf";
      if (value != null && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, shape(v)]),
        );
      }
      return "leaf";
    };
    expect(shape(UI.ja)).toEqual(shape(UI.en));
  });

  it("ja suggestions differ from en (actually translated)", () => {
    const en: UIStrings = UI.en;
    const ja: UIStrings = UI.ja;
    expect(ja.chat.suggestions).not.toEqual(en.chat.suggestions);
    expect(ja.chrome.navDashboard).not.toBe(en.chrome.navDashboard);
  });
});

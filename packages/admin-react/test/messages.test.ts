import { describe, expect, it } from "vitest";
import { defaultAdminMessages } from "../src/index.js";

// Mirrors sample-web's ui-strings.test: no leaf may be an empty string, and parameterized messages must return text.
function walk(value: unknown, path: string): void {
  if (typeof value === "string") {
    expect(value.trim(), `${path} must not be empty`).not.toBe("");
    return;
  }
  if (typeof value === "function") {
    const probed = (value as (...args: unknown[]) => string)("x", "y", "z");
    expect(typeof probed, `${path}(…) must return a string`).toBe("string");
    expect(probed.trim(), `${path}(…) must not be empty`).not.toBe("");
    return;
  }
  if (value != null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
  }
}

describe("defaultAdminMessages", () => {
  it("has no empty strings", () => {
    walk(defaultAdminMessages, "admin");
  });
  it("keeps the four tab labels the sample shipped with", () => {
    expect(defaultAdminMessages.tabLineage).toBe("View Lineage");
    expect(defaultAdminMessages.tabPromotions).toBe("Promotion Review (L2→L1)");
  });
});

import { describe, expect, it } from "vitest";
import { normalizeTenant } from "../src/ports.js";

describe("normalizeTenant", () => {
  it("collapses undefined, null, and the empty string to undefined", () => {
    expect(normalizeTenant(undefined)).toBeUndefined();
    expect(normalizeTenant(null)).toBeUndefined();
    expect(normalizeTenant("")).toBeUndefined();
  });

  it("passes any non-empty string through unchanged", () => {
    expect(normalizeTenant("acme")).toBe("acme");
  });

  it("treats an empty-string tenant as equivalent to an unspecified one", () => {
    expect(normalizeTenant("")).toBe(normalizeTenant(undefined));
  });
});

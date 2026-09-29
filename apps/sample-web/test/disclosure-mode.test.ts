import { describe, expect, it } from "vitest";
import { resolveDisclosureMode } from "../src/kohaku/disclosure.js";

describe("resolveDisclosureMode", () => {
  it("defaults to off when unset", () => {
    expect(resolveDisclosureMode(undefined)).toBe("off");
  });

  it("accepts the two enabled modes", () => {
    expect(resolveDisclosureMode("attributes")).toBe("attributes");
    expect(resolveDisclosureMode("label")).toBe("label");
  });

  it("treats off and any unrecognized value as off", () => {
    expect(resolveDisclosureMode("off")).toBe("off");
    expect(resolveDisclosureMode("Label")).toBe("off");
    expect(resolveDisclosureMode("")).toBe("off");
  });
});

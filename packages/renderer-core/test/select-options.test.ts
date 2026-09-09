import type { JsonValue } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { normalizeSelectOptions } from "../src/index.js";

describe("normalizeSelectOptions (for control.select, JsonValue input)", () => {
  it("maps string to { value, label }", () => {
    expect(normalizeSelectOptions(["a", "b"])).toEqual([
      { value: "a", label: "a" },
      { value: "b", label: "b" },
    ]);
  });

  it("keeps { value, label } as-is; missing label falls back to value/empty string", () => {
    const input: JsonValue = [{ value: "jp", label: "Japan" }, { value: "us" }];
    expect(normalizeSelectOptions(input)).toEqual([
      { value: "jp", label: "Japan" },
      { value: "us", label: "us" },
    ]);
  });

  it("non-array input yields an empty array (same rule as renderer-react's control-select)", () => {
    expect(normalizeSelectOptions(undefined)).toEqual([]);
    expect(normalizeSelectOptions("nope" as JsonValue)).toEqual([]);
    expect(normalizeSelectOptions(null)).toEqual([]);
  });
});

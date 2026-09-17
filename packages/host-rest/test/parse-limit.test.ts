import { describe, expect, it } from "vitest";
import { parseLimit } from "../src/routes/governance.js";

// Representative-input table shared with Python's test_parse_limit (kohaku.host_rest._routes.shared
// ._parse_limit is meant to be isomorphic to this function). Only a plain decimal-digit string (with an
// optional decimal point) is accepted -- hex / scientific notation / underscore separators, all of which
// a bare `Number(raw)` (TS) or `float(raw)` (Python) would otherwise accept in one language but not the
// other, are rejected in both.
describe("parseLimit", () => {
  const MAX_LIMIT = 1000;

  it.each([
    ["", undefined],
    ["0", undefined],
    ["-1", undefined],
    ["abc", undefined],
    ["0x10", undefined], // hex: Number("0x10") is 16, but this is not a decimal-digit string.
    ["1_000", undefined], // numeric-separator underscore: Number("1_000") is NaN already, but pin it explicitly.
    ["1e3", undefined], // scientific notation: Number("1e3") is 1000, but this is not a decimal-digit string.
    ["1.9", 1], // a valid decimal is floored.
    ["500", 500],
    ["5000", MAX_LIMIT], // over the limit is clamped, not rejected.
  ] as const)("parseLimit(%j, 1000) -> %j", (raw, expected) => {
    expect(parseLimit(raw, MAX_LIMIT)).toBe(expected);
  });

  it("undefined input (query param absent) is undefined", () => {
    expect(parseLimit(undefined, MAX_LIMIT)).toBeUndefined();
  });
});

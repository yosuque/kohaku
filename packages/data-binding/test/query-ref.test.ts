import { describe, expect, it } from "vitest";
import { assertKnownReservedParams, splitReservedParams } from "../src/query-ref.js";

// The reserved namespace (leading `_`) is outside capability validation, so passing anything other than known keys
// straight through is a hole where "an out-of-authorization parameter can change the data range". This pins the allowlist boundary.
describe("assertKnownReservedParams (allowlist of reserved keys)", () => {
  it("passes known reserved keys (_cursor / _limit / _sort / _dir)", () => {
    expect(() =>
      assertKnownReservedParams({ _cursor: "c", _limit: "10", _sort: "k", _dir: "asc" }),
    ).not.toThrow();
    expect(() => assertKnownReservedParams({})).not.toThrow();
  });

  it("rejects unknown `_` keys with a Japanese error message", () => {
    expect(() => assertKnownReservedParams({ _tenant: "other" })).toThrow(/reserved parameter/);
    expect(() => assertKnownReservedParams({ _includeDeleted: "1" })).toThrow(/_includeDeleted/);
  });

  it("can detect unknown keys in combination with splitReservedParams", () => {
    const { reserved } = splitReservedParams("query://sales/records?_evil=1&fy=2026");
    expect(() => assertKnownReservedParams(reserved)).toThrow(/_evil/);
  });
});

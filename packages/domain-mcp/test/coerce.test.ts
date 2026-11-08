import { describe, expect, it } from "vitest";
import { coerceToolArguments, McpArgumentError } from "../src/coerce.js";

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    n: { type: "number" },
    b: { type: "boolean" },
    s: { type: "string" },
    limit: { type: "integer" },
  },
};

describe("coerceToolArguments", () => {
  it("coerces string arguments by the inputSchema type and maps _limit onto limit", () => {
    expect(coerceToolArguments({ n: "3", b: "true", s: "x", _limit: "5", _sort: "a" }, INPUT_SCHEMA)).toEqual(
      {
        n: 3,
        b: true,
        s: "x",
        limit: 5,
      },
    );
  });

  it("never forwards the reserved parameters", () => {
    expect(
      coerceToolArguments({ _cursor: "c", _limit: "2", _sort: "s", _dir: "asc", s: "x" }, { type: "object" }),
    ).toEqual({ s: "x" });
  });

  it("lets _limit win over an explicit limit, and ignores _limit when the tool has no limit argument", () => {
    expect(coerceToolArguments({ limit: "9", _limit: "5" }, INPUT_SCHEMA)).toEqual({ limit: 5 });
    expect(
      coerceToolArguments({ _limit: "5", s: "x" }, { type: "object", properties: { s: { type: "string" } } }),
    ).toEqual({ s: "x" });
  });

  it("passes strings through for string, unknown, and untyped properties", () => {
    expect(
      coerceToolArguments(
        { s: "1", other: "2", t: "true" },
        { type: "object", properties: { s: { type: "string" }, t: {} } },
      ),
    ).toEqual({
      s: "1",
      other: "2",
      t: "true",
    });
  });

  it("keeps values that are already typed", () => {
    expect(coerceToolArguments({ n: 4, b: false }, INPUT_SCHEMA)).toEqual({ n: 4, b: false });
  });

  it("accepts an integral decimal for integer and rejects a fractional one", () => {
    expect(coerceToolArguments({ limit: "3.0" }, INPUT_SCHEMA)).toEqual({ limit: 3 });
    expect(() => coerceToolArguments({ limit: "3.5" }, INPUT_SCHEMA)).toThrow(McpArgumentError);
  });

  it.each([
    ["a non-numeric number", { n: "abc" }],
    ["an empty number", { n: "" }],
    ["a padded number", { n: " 3" }],
    ["a hex number", { n: "0x10" }],
    ["an overflowing number", { n: "1e400" }],
    ["a non-boolean boolean", { b: "yes" }],
    ["a capitalised boolean", { b: "True" }],
    ["a bad _limit", { _limit: "many" }],
  ])("throws ACTION_PARAMS_INVALID for %s", (_label, args) => {
    try {
      coerceToolArguments(args, INPUT_SCHEMA);
      expect.unreachable("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(McpArgumentError);
      expect((error as McpArgumentError).code).toBe("ACTION_PARAMS_INVALID");
    }
  });

  it("tolerates an inputSchema without properties", () => {
    expect(coerceToolArguments({ a: "1" }, { type: "object" })).toEqual({ a: "1" });
  });
});

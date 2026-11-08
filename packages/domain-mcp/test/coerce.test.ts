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

  it("ignores _limit when the tool has no limit argument", () => {
    expect(coerceToolArguments({ limit: "9", _limit: "5" }, INPUT_SCHEMA)).toEqual({ limit: 5 });
    expect(
      coerceToolArguments({ _limit: "5", s: "x" }, { type: "object", properties: { s: { type: "string" } } }),
    ).toEqual({ s: "x" });
  });

  it("lets _limit only lower the signed limit: the smaller of the two wins", () => {
    expect(coerceToolArguments({ limit: "3", _limit: "5" }, INPUT_SCHEMA)).toEqual({ limit: 3 });
    expect(coerceToolArguments({ limit: "9", _limit: "5" }, INPUT_SCHEMA)).toEqual({ limit: 5 });
    expect(coerceToolArguments({ limit: 4, _limit: "5" }, INPUT_SCHEMA)).toEqual({ limit: 4 });
  });

  it.each([
    ["negative", "-1"],
    ["a large negative", "-1e9"],
    ["zero", "0"],
    ["fractional", "0.5"],
    ["fractional above one", "1.5"],
    ["non-numeric", "abc"],
    ["empty", ""],
    ["beyond the safe integers", "9007199254740993"],
    ["a typed negative", -1],
    ["a typed zero", 0],
    ["a typed fraction", 0.5],
    ["a typed boolean", true],
  ])(
    "refuses an _limit that is not a positive integer (%s): it can never widen the signed limit",
    (_l, bad) => {
      for (const schema of [INPUT_SCHEMA, { type: "object", properties: { limit: { type: "number" } } }]) {
        for (const args of [{ limit: "1", _limit: bad }, { _limit: bad }]) {
          try {
            coerceToolArguments(args as never, schema);
            expect.unreachable("expected a throw");
          } catch (error) {
            expect(error).toBeInstanceOf(McpArgumentError);
            expect((error as McpArgumentError).message).toBe(
              'argument "_limit": expected a positive integer',
            );
          }
        }
      }
    },
  );

  it("accepts a positive integer _limit however it is spelled", () => {
    expect(coerceToolArguments({ limit: "9", _limit: "5.0" }, INPUT_SCHEMA)).toEqual({ limit: 5 });
    expect(coerceToolArguments({ limit: "9", _limit: "1e1" }, INPUT_SCHEMA)).toEqual({ limit: 9 });
    expect(coerceToolArguments({ limit: "9", _limit: 3 }, INPUT_SCHEMA)).toEqual({ limit: 3 });
    expect(coerceToolArguments({ _limit: "1" }, INPUT_SCHEMA)).toEqual({ limit: 1 });
  });

  it("caps the limit at maxLimit (default 1000), whichever way it was supplied", () => {
    expect(coerceToolArguments({ limit: "5000" }, INPUT_SCHEMA)).toEqual({ limit: 1000 });
    expect(coerceToolArguments({ _limit: "2000" }, INPUT_SCHEMA)).toEqual({ limit: 1000 });
    expect(coerceToolArguments({ limit: "50", _limit: "40" }, INPUT_SCHEMA, { maxLimit: 10 })).toEqual({
      limit: 10,
    });
    expect(coerceToolArguments({ limit: "5" }, INPUT_SCHEMA, { maxLimit: 10 })).toEqual({ limit: 5 });
  });

  it("does not invent a limit when none is supplied, nor map _limit onto a non-numeric limit", () => {
    expect(coerceToolArguments({ s: "x" }, INPUT_SCHEMA)).toEqual({ s: "x" });
    const stringLimit = { type: "object", properties: { limit: { type: "string" } } };
    expect(coerceToolArguments({ _limit: "5" }, stringLimit)).toEqual({});
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
  ])("throws MCP_ARGUMENT_INVALID for %s", (_label, args) => {
    try {
      coerceToolArguments(args, INPUT_SCHEMA);
      expect.unreachable("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(McpArgumentError);
      expect((error as McpArgumentError).code).toBe("MCP_ARGUMENT_INVALID");
    }
  });

  it("reads the type through a nullable anyOf (how Pydantic writes Optional[...])", () => {
    const nullable = {
      type: "object",
      properties: {
        limit: { anyOf: [{ type: "integer" }, { type: "null" }], default: null },
        flag: { anyOf: [{ type: "null" }, { type: "boolean" }] },
        either: { anyOf: [{ type: "integer" }, { type: "string" }] },
      },
    };
    expect(coerceToolArguments({ limit: "5", flag: "true", either: "7" }, nullable)).toEqual({
      limit: 5,
      flag: true,
      either: "7",
    });
    expect(() => coerceToolArguments({ limit: "x" }, nullable)).toThrow(McpArgumentError);
  });

  it("tolerates an inputSchema without properties", () => {
    expect(coerceToolArguments({ a: "1" }, { type: "object" })).toEqual({ a: "1" });
  });
});

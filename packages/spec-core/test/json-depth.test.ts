import { describe, expect, it } from "vitest";
import {
  exceedsMaxJsonDepth,
  JsonObjectSchema,
  JsonValueSchema,
  MAX_JSON_OBJECT_DEPTH,
} from "../src/index.js";

/**
 * Builds a JSON object literal nested `depth` levels deep (a bare `{leaf:true}` is depth 1), by mutating a
 * loop variable rather than recursing -- so the fixture itself can reach depths (5000 / 100000) that would
 * overflow the stack if it were built by a recursive helper.
 */
function nestedObject(depth: number): Record<string, unknown> {
  let obj: Record<string, unknown> = { leaf: true };
  for (let i = 1; i < depth; i++) {
    obj = { nested: obj };
  }
  return obj;
}

describe("exceedsMaxJsonDepth", () => {
  it("is false for a scalar, an empty object, and an empty array", () => {
    expect(exceedsMaxJsonDepth("s", 32)).toBe(false);
    expect(exceedsMaxJsonDepth(42, 32)).toBe(false);
    expect(exceedsMaxJsonDepth(null, 32)).toBe(false);
    expect(exceedsMaxJsonDepth({}, 32)).toBe(false);
    expect(exceedsMaxJsonDepth([], 32)).toBe(false);
  });

  it("does not overflow the stack on a 100000-level-deep object, and correctly reports it as too deep", () => {
    expect(exceedsMaxJsonDepth(nestedObject(100_000), 32)).toBe(true);
  });

  it("treats an array's nesting the same as an object's", () => {
    let arr: unknown = ["leaf"];
    for (let i = 1; i < 100_000; i++) arr = [arr];
    expect(exceedsMaxJsonDepth(arr, 32)).toBe(true);
  });
});

describe("JsonValueSchema (no depth cap prior to this fix -- see MAX_JSON_OBJECT_DEPTH's doc comment)", () => {
  it("accepts a value nested exactly MAX_JSON_OBJECT_DEPTH levels deep", () => {
    expect(JsonValueSchema.safeParse(nestedObject(MAX_JSON_OBJECT_DEPTH)).success).toBe(true);
  });

  it("rejects a value nested MAX_JSON_OBJECT_DEPTH + 1 levels deep with a ZodError, not a RangeError", () => {
    const result = JsonValueSchema.safeParse(nestedObject(MAX_JSON_OBJECT_DEPTH + 1));
    expect(result.success).toBe(false);
  });

  it.each([5000, 100_000])("rejects a value nested %i levels deep without throwing", (depth) => {
    let result: ReturnType<typeof JsonValueSchema.safeParse> | undefined;
    expect(() => {
      result = JsonValueSchema.safeParse(nestedObject(depth));
    }).not.toThrow();
    expect(result?.success).toBe(false);
  });

  it("still rejects non-JSON values the same as before (a function)", () => {
    expect(JsonValueSchema.safeParse(() => {}).success).toBe(false);
  });
});

describe("JsonObjectSchema (the top-level object itself = depth 1)", () => {
  it("accepts an object nested exactly 32 levels deep (at the limit)", () => {
    expect(JsonObjectSchema.safeParse(nestedObject(32)).success).toBe(true);
  });

  it("rejects an object nested 33 levels deep (just over the limit) with a ZodError, not a RangeError", () => {
    const result = JsonObjectSchema.safeParse(nestedObject(33));
    expect(result.success).toBe(false);
  });

  it.each([5000, 100_000])(
    "rejects an object nested %i levels deep without throwing (RangeError would previously escape safeParse)",
    (depth) => {
      let result: ReturnType<typeof JsonObjectSchema.safeParse> | undefined;
      expect(() => {
        result = JsonObjectSchema.safeParse(nestedObject(depth));
      }).not.toThrow();
      expect(result?.success).toBe(false);
    },
  );

  it("rejects a non-object top-level value (an array) the same as before", () => {
    expect(JsonObjectSchema.safeParse([1, 2, 3]).success).toBe(false);
  });

  it("rejects a shallow but malformed value (a number instead of a record)", () => {
    expect(JsonObjectSchema.safeParse(42).success).toBe(false);
  });
});

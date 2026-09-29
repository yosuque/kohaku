import { describe, expect, it } from "vitest";
import { findDuplicateJsonKey } from "../../src/evidence/strict-json.js";

describe("findDuplicateJsonKey", () => {
  it("returns undefined for documents whose object keys are unique", () => {
    expect(findDuplicateJsonKey('{"a":1,"b":{"a":2,"c":[{"a":1},{"a":2}]},"d":"a"}')).toBeUndefined();
    expect(findDuplicateJsonKey("[]")).toBeUndefined();
    expect(findDuplicateJsonKey('"a"')).toBeUndefined();
  });

  it("finds a duplicate at the top level and at depth", () => {
    expect(findDuplicateJsonKey('{"a":1,"a":2}')).toBe("a");
    expect(findDuplicateJsonKey('{"x":{"y":[{"k":1,"k":2}]}}')).toBe("k");
    expect(findDuplicateJsonKey('{"a":{"b":1},"a":2}')).toBe("a");
  });

  it("compares keys after unescaping", () => {
    expect(findDuplicateJsonKey('{"a":1,"\\u0061":2}')).toBe("a");
  });

  it("does not mistake string values or escaped quotes for keys", () => {
    expect(findDuplicateJsonKey('{"a":"a","b":"a\\"","c":"{\\"a\\":1,\\"a\\":2}"}')).toBeUndefined();
  });
});

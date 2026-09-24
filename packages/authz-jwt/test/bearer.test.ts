import { describe, expect, it } from "vitest";
import { bearerToken } from "../src/bearer.js";

describe("bearerToken", () => {
  it("extracts the token from a Bearer header, scheme case-insensitively, trimming whitespace", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerToken("bearer   abc ")).toBe("abc");
  });
  it("returns null for a missing header, another scheme, or an empty token", () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken("Bearer ")).toBeNull();
  });
});

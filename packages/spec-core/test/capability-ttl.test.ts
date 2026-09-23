import { describe, expect, it } from "vitest";
import { DEFAULT_CAPABILITY_TTL_SECONDS } from "../src/index.js";

describe("DEFAULT_CAPABILITY_TTL_SECONDS", () => {
  it("is 600 seconds", () => {
    expect(DEFAULT_CAPABILITY_TTL_SECONDS).toBe(600);
  });
});

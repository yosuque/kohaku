import { DEFAULT_CAPABILITY_TTL_SECONDS as SPEC_CORE_DEFAULT_CAPABILITY_TTL_SECONDS } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { DEFAULT_CAPABILITY_TTL_SECONDS } from "../src/index.js";

describe("host-core's re-exported DEFAULT_CAPABILITY_TTL_SECONDS", () => {
  it("is the same value as spec-core's (would fail if host-core reintroduced a local copy)", () => {
    expect(DEFAULT_CAPABILITY_TTL_SECONDS).toBe(SPEC_CORE_DEFAULT_CAPABILITY_TTL_SECONDS);
  });
});

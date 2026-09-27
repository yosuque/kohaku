import { afterEach, describe, expect, it, vi } from "vitest";
import { isDevEnvironment } from "../src/dev-mode.js";

describe("isDevEnvironment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is true when NODE_ENV is not "production" (e.g. vitest\'s own "test")', () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(isDevEnvironment()).toBe(true);
  });

  it('is false when NODE_ENV is "production"', () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isDevEnvironment()).toBe(false);
  });

  it("is true (the safe default) when NODE_ENV is unset", () => {
    vi.stubEnv("NODE_ENV", undefined);
    expect(isDevEnvironment()).toBe(true);
  });
});

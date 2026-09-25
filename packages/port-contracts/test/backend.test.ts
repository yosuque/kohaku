import { describe, expect, it } from "vitest";
import { resolveAdapterBackend } from "../src/backend.js";

describe("resolveAdapterBackend", () => {
  it("prefers an explicit URL from the environment over Docker", () => {
    const backend = resolveAdapterBackend(
      "redis",
      { KOHAKU_TEST_REDIS_URL: "redis://localhost:6379/1" },
      () => true,
    );
    expect(backend).toEqual({ mode: "url", url: "redis://localhost:6379/1" });
  });

  it("falls back to a container when Docker is available and no URL is set", () => {
    expect(resolveAdapterBackend("postgres", {}, () => true)).toEqual({ mode: "container" });
  });

  it("skips (with a reason) when neither a URL nor Docker is available", () => {
    const backend = resolveAdapterBackend("postgres", {}, () => false);
    expect(backend.mode).toBe("skip");
    if (backend.mode === "skip") expect(backend.reason).toContain("KOHAKU_TEST_POSTGRES_URL");
  });

  it("throws instead of skipping when KOHAKU_ADAPTER_TESTS=require", () => {
    expect(() => resolveAdapterBackend("redis", { KOHAKU_ADAPTER_TESTS: "require" }, () => false)).toThrow(
      /KOHAKU_ADAPTER_TESTS=require/,
    );
  });

  it("never probes Docker when a URL is present (the probe is not called)", () => {
    let probed = false;
    resolveAdapterBackend("postgres", { KOHAKU_TEST_POSTGRES_URL: "postgres://x" }, () => {
      probed = true;
      return true;
    });
    expect(probed).toBe(false);
  });
});

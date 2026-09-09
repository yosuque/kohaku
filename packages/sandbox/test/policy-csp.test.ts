import { describe, expect, it } from "vitest";
import { applyRuntimeNonce, DEFAULT_CSP, resolveCsp, resolvePolicy } from "../src/policy.js";

// Pins that SandboxPolicy.csp is a validated composition (relaxation forbidden), not a full replacement.
// Because allowing full replacement would let a single `connect-src *` erase the L2 closed area (the second layer of the triple defense).
describe("resolveCsp (blocking directives cannot be relaxed)", () => {
  it("returns the default CSP as-is when unspecified", () => {
    expect(resolveCsp(undefined)).toBe(DEFAULT_CSP);
    expect(resolvePolicy({}).csp).toBe(DEFAULT_CSP);
  });

  it("relaxing connect-src / default-src is rejected Fail Fast", () => {
    expect(() => resolveCsp("connect-src *")).toThrow(/connect-src/);
    expect(() => resolveCsp("connect-src https://evil.example")).toThrow(/connect-src/);
    expect(() => resolvePolicy({ csp: "default-src *" })).toThrow(/default-src/);
    expect(() => resolveCsp("form-action https://evil.example")).toThrow(/form-action/);
    expect(() => resolveCsp("frame-src https://evil.example")).toThrow(/frame-src/);
  });

  it("overriding non-blocking directives (style-src / img-src etc.) with a closed value is allowed, and blocking defaults are always filled in", () => {
    const resolved = resolveCsp("style-src 'unsafe-inline'; img-src data:");
    expect(resolved).toContain("style-src 'unsafe-inline'");
    expect(resolved).toContain("img-src data:");
    // Blocking directives are filled in with the default value ('none') even if custom omits them.
    expect(resolved).toContain("default-src 'none'");
    expect(resolved).toContain("connect-src 'none'");
    expect(resolved).toContain("form-action 'none'");
    expect(resolved).toContain("base-uri 'none'");
    expect(resolved).toContain("object-src 'none'");
    expect(resolved).toContain("frame-src 'none'");
  });

  it("stating blocking directives explicitly at their default value is allowed (idempotent)", () => {
    expect(() => resolveCsp("connect-src 'none'; img-src data: blob:")).not.toThrow();
  });

  it("img-src / font-src / media-src / style-src with https:, *, a hostname, or ws: are rejected Fail Fast", () => {
    expect(() => resolveCsp("img-src https:")).toThrow(/img-src/);
    expect(() => resolveCsp("img-src *")).toThrow(/img-src/);
    expect(() => resolveCsp("font-src https://fonts.example.com")).toThrow(/font-src/);
    expect(() => resolveCsp("media-src https://cdn.example.com")).toThrow(/media-src/);
    expect(() => resolveCsp("style-src ws:")).toThrow(/style-src/);
  });

  it("script-src / script-src-elem / script-src-attr / worker-src / child-src cannot be set at all (managed by the sandbox runtime), even to restate the default", () => {
    for (const directive of ["script-src", "script-src-elem", "script-src-attr", "worker-src", "child-src"]) {
      expect(() => resolveCsp(`${directive} 'unsafe-inline'`)).toThrow(
        new RegExp(`${directive}.*managed by the sandbox runtime`),
      );
      // Even the exact default value is rejected — script-src's real value differs per mount (the nonce),
      // so there is nothing meaningful for a caller to "restate".
      expect(() => resolveCsp(`${directive} 'none'`)).toThrow(/managed by the sandbox runtime/);
    }
  });

  it("omitting script-src / worker-src / child-src always fills in the DEFAULT_CSP value", () => {
    const resolved = resolveCsp("style-src 'unsafe-inline'");
    expect(resolved).toContain("script-src 'none'");
    expect(resolved).toContain("worker-src blob:");
    expect(resolved).toContain("child-src blob:");
  });

  it("'self' is rejected (meaningless under the opaque origin)", () => {
    expect(() => resolveCsp("img-src 'self'")).toThrow(/img-src/);
  });

  it("report-uri / report-to / unknown directives are rejected", () => {
    expect(() => resolveCsp("report-uri https://collector.example/csp")).toThrow(/report-uri/);
    expect(() => resolveCsp("report-to csp-endpoint")).toThrow(/report-to/);
    expect(() => resolveCsp("navigate-to 'self'")).toThrow(/navigate-to/);
    expect(() => resolveCsp("some-unknown-directive foo")).toThrow(/some-unknown-directive/);
  });

  it("idempotent for the non-runtime-managed directives: restating them at their default value throws nothing and resolves to the same values", () => {
    // A previously-resolved CSP always carries a per-mount script-src nonce (applyRuntimeNonce), which can
    // never be "restated" (see above), so full byte-identity with DEFAULT_CSP is not the right pin here —
    // only that every directive a caller COULD legitimately restate round-trips to the same value.
    const resolved = resolveCsp(
      "default-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; style-src 'unsafe-inline'; img-src data: blob:",
    );
    expect(resolved).toContain("default-src 'none'");
    expect(resolved).toContain("connect-src 'none'");
    expect(resolved).toContain("script-src 'none'");
    expect(resolved).toContain("worker-src blob:");
    expect(resolved).toContain("child-src blob:");
  });
});

describe("applyRuntimeNonce", () => {
  it("substitutes the per-mount nonce into script-src 'none'", () => {
    const resolved = resolveCsp(undefined);
    const withNonce = applyRuntimeNonce(resolved, "abc123");
    expect(withNonce).toContain("script-src 'nonce-abc123'");
    expect(withNonce).not.toContain("script-src 'none'");
  });

  it("leaves every other directive untouched", () => {
    const withNonce = applyRuntimeNonce(DEFAULT_CSP, "abc123");
    expect(withNonce).toContain("connect-src 'none'");
    expect(withNonce).toContain("worker-src blob:");
    expect(withNonce).toContain("child-src blob:");
  });
});

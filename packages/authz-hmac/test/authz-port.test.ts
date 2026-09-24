import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmacAuthzPort } from "../src/index.js";

// Scope matching is exact (the contract in spec-core ports.ts). A prefix match would let value/name boundaries slip through
// (?region=us allowing ?region=usa, annotate allowing annotateAll), so pin down that regression.
describe("createHmacAuthzPort scope matching (exact match)", () => {
  const principal = { id: "u", roles: ["user"] };

  it("read scope does not cross value boundaries (?region=us does not allow ?region=usa)", async () => {
    const authz = createHmacAuthzPort("test-secret");
    const cap = await authz.issueCapability(principal, [
      { kind: "read", ref: "query://sales/summary?region=us" },
    ]);
    expect((await authz.verify(cap, { kind: "read", ref: "query://sales/summary?region=us" })).ok).toBe(true);
    expect((await authz.verify(cap, { kind: "read", ref: "query://sales/summary?region=usa" })).ok).toBe(
      false,
    );
  });

  it("write scope does not allow action name prefix matching (annotate does not allow annotateAll)", async () => {
    const authz = createHmacAuthzPort("test-secret");
    const cap = await authz.issueCapability(principal, [{ kind: "write", ref: "annotate" }]);
    expect((await authz.verify(cap, { kind: "write", ref: "annotate" })).ok).toBe(true);
    expect((await authz.verify(cap, { kind: "write", ref: "annotateAll" })).ok).toBe(false);
  });
});

describe("createHmacAuthzPort capability expiry", () => {
  const principal = { id: "u", roles: ["user"] };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a capability is rejected as expired once its ttlSeconds has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const authz = createHmacAuthzPort("test-secret");
    const cap = await authz.issueCapability(principal, [{ kind: "read", ref: "query://sales/summary" }], {
      ttlSeconds: 1,
    });

    // Still valid immediately after issuance.
    expect((await authz.verify(cap, { kind: "read", ref: "query://sales/summary" })).ok).toBe(true);

    // Advance past the TTL.
    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    const result = await authz.verify(cap, { kind: "read", ref: "query://sales/summary" });
    expect(result).toEqual({ ok: false, reason: "capability expired" });
  });

  it("a capability is still valid exactly at its expiry instant (exp < now, not <=)", async () => {
    vi.useFakeTimers();
    const issuedAt = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(issuedAt);
    const authz = createHmacAuthzPort("test-secret");
    const cap = await authz.issueCapability(principal, [{ kind: "read", ref: "query://sales/summary" }], {
      ttlSeconds: 1,
    });

    // exp = floor(issuedAt/1000) + 1. Advance the clock exactly to that instant (verify's check is `exp < now`,
    // so `exp === now` must still be valid).
    const expSeconds = Math.floor(issuedAt.getTime() / 1000) + 1;
    vi.setSystemTime(new Date(expSeconds * 1000));
    const result = await authz.verify(cap, { kind: "read", ref: "query://sales/summary" });
    expect(result.ok).toBe(true);
  });
});

describe("createHmacAuthzPort options.ttlSeconds", () => {
  const principal = { id: "u" };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses options.ttlSeconds as the default TTL and lets issueCapability's opts override it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const authz = createHmacAuthzPort("test-secret", { ttlSeconds: 2 });
    const short = await authz.issueCapability(principal, [{ kind: "read", ref: "query://s/x" }]);
    const long = await authz.issueCapability(principal, [{ kind: "read", ref: "query://s/x" }], {
      ttlSeconds: 10,
    });
    vi.setSystemTime(new Date("2026-01-01T00:00:03.000Z"));
    expect((await authz.verify(short, { kind: "read", ref: "query://s/x" })).ok).toBe(false);
    expect((await authz.verify(long, { kind: "read", ref: "query://s/x" })).ok).toBe(true);
  });
});

import { createHmac } from "node:crypto";
import type { CapabilityRevocationStore } from "@kohaku-ui/spec-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmacAuthzPort } from "../src/index.js";

/** Builds a jti-less token with the same wire shape as createHmacAuthzPort -- issueCapability always
 * stamps a jti, so a jti-less token (as a pre-upgrade instance would have minted) is built by hand,
 * mirroring revocation.test.ts's issuePreUpgradeToken. */
function issueJtiLessToken(secret: string, sub: string, exp: number): string {
  const payload = Buffer.from(
    JSON.stringify({ sub, scopes: [{ kind: "read", ref: "query://s/x" }], exp }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

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

  it("a capability is rejected as expired exactly at its expiry instant (exp <= now, not exp < now)", async () => {
    vi.useFakeTimers();
    const issuedAt = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(issuedAt);
    const authz = createHmacAuthzPort("test-secret");
    const cap = await authz.issueCapability(principal, [{ kind: "read", ref: "query://sales/summary" }], {
      ttlSeconds: 1,
    });

    // exp = floor(issuedAt/1000) + 1. Advance the clock exactly to that instant: the shared isExpired
    // boundary is `exp <= now`, so `exp === now` must already be expired (not "still valid for one more
    // second", which was the pre-hardening behavior).
    const expSeconds = Math.floor(issuedAt.getTime() / 1000) + 1;
    vi.setSystemTime(new Date(expSeconds * 1000));
    const result = await authz.verify(cap, { kind: "read", ref: "query://sales/summary" });
    expect(result).toEqual({ ok: false, reason: "capability expired" });
  });

  it("a capability is still valid one second before its expiry instant", async () => {
    vi.useFakeTimers();
    const issuedAt = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(issuedAt);
    const authz = createHmacAuthzPort("test-secret");
    const cap = await authz.issueCapability(principal, [{ kind: "read", ref: "query://sales/summary" }], {
      ttlSeconds: 2,
    });

    const oneSecondBeforeExp = Math.floor(issuedAt.getTime() / 1000) + 1;
    vi.setSystemTime(new Date(oneSecondBeforeExp * 1000));
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

describe("createHmacAuthzPort options.requireJti", () => {
  const principal = { id: "u", roles: ["user"] };

  it("default (false): a jti-less token still verifies fine", async () => {
    const authz = createHmacAuthzPort("test-secret");
    const cap = await authz.issueCapability(principal, [{ kind: "read", ref: "query://s/x" }]);
    expect((await authz.verify(cap, { kind: "read", ref: "query://s/x" })).ok).toBe(true);
  });

  it("true: rejects a jti-less token with reason 'capability lacks jti'", async () => {
    const authz = createHmacAuthzPort("test-secret", { requireJti: true });
    const jtiLess = issueJtiLessToken("test-secret", principal.id, Math.floor(Date.now() / 1000) + 3600);

    const result = await authz.verify(jtiLess, { kind: "read", ref: "query://s/x" });
    expect(result).toEqual({ ok: false, reason: "capability lacks jti" });
  });

  it("true: a token that does carry a jti still verifies normally", async () => {
    const authz = createHmacAuthzPort("test-secret", { requireJti: true });
    const cap = await authz.issueCapability(principal, [{ kind: "read", ref: "query://s/x" }]);
    expect((await authz.verify(cap, { kind: "read", ref: "query://s/x" })).ok).toBe(true);
  });
});

describe("createHmacAuthzPort verify: scope evaluated before the revocation store", () => {
  const principal = { id: "u", roles: ["user"] };

  it("an out-of-scope request never calls isRevoked (no store round trip for a request that fails anyway)", async () => {
    const calls: string[] = [];
    const revocations: CapabilityRevocationStore = {
      async revoke(jti) {
        calls.push(`revoke:${jti}`);
      },
      async isRevoked(jti) {
        calls.push(`isRevoked:${jti}`);
        return false;
      },
    };
    const authz = createHmacAuthzPort("test-secret", { revocations });
    const cap = await authz.issueCapability(principal, [{ kind: "read", ref: "query://s/x" }]);

    const result = await authz.verify(cap, { kind: "read", ref: "query://s/y" });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("a revocation-store rejection propagates as a thrown error (fail-closed), for an in-scope request", async () => {
    const revocations: CapabilityRevocationStore = {
      async revoke() {},
      async isRevoked() {
        throw new Error("store unavailable (test)");
      },
    };
    const authz = createHmacAuthzPort("test-secret", { revocations });
    const cap = await authz.issueCapability(principal, [{ kind: "read", ref: "query://s/x" }]);

    await expect(authz.verify(cap, { kind: "read", ref: "query://s/x" })).rejects.toThrow(
      "store unavailable (test)",
    );
  });
});

import { createHmac } from "node:crypto";
import type { CapabilityRevocationStore } from "@kohaku-ui/spec-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmacAuthzPort } from "../src/index.js";

const principal = { id: "u", roles: ["user"] };

/** Builds a token with the same wire shape as createHmacAuthzPort, but without a jti — simulating a
 * capability minted by a pre-upgrade instance during a rolling deploy. */
function issuePreUpgradeToken(secret: string, exp: number): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: principal.id, scopes: [{ kind: "read", ref: "query://s/x" }], exp }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

describe("createHmacAuthzPort capability revocation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("verifies ok, then reports revoked once revokeCapability has been called", async () => {
    const authz = createHmacAuthzPort("test-secret");
    const cap = await authz.issueCapability(principal, [{ kind: "read", ref: "query://s/x" }]);

    expect((await authz.verify(cap, { kind: "read", ref: "query://s/x" })).ok).toBe(true);

    const revoked = await authz.revokeCapability(cap);
    expect(revoked).toEqual({ ok: true });

    const result = await authz.verify(cap, { kind: "read", ref: "query://s/x" });
    expect(result).toEqual({ ok: false, reason: "capability revoked" });
  });

  it("rejects revocation of a tampered or foreign token (signature verified first)", async () => {
    const authz = createHmacAuthzPort("test-secret");
    const cap = await authz.issueCapability(principal, [{ kind: "read", ref: "query://s/x" }]);
    const tampered = `${cap.slice(0, -2)}${cap.endsWith("AA") ? "BB" : "AA"}`;

    const result = await authz.revokeCapability(tampered);
    expect(result.ok).toBe(false);

    // A forged token signed with a different secret must also be rejected, not merely "not found".
    const foreign = await createHmacAuthzPort("other-secret").issueCapability(principal, [
      { kind: "read", ref: "query://s/x" },
    ]);
    const foreignResult = await authz.revokeCapability(foreign);
    expect(foreignResult.ok).toBe(false);
  });

  it("verifies a jti-less (pre-upgrade) token ok, but cannot revoke it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const authz = createHmacAuthzPort("test-secret");
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const legacyToken = issuePreUpgradeToken("test-secret", exp);

    expect((await authz.verify(legacyToken, { kind: "read", ref: "query://s/x" })).ok).toBe(true);

    const result = await authz.revokeCapability(legacyToken);
    expect(result).toEqual({ ok: false, reason: "token predates revocation support" });

    // And it must still verify fine afterwards -- the failed revoke must not have broken anything.
    expect((await authz.verify(legacyToken, { kind: "read", ref: "query://s/x" })).ok).toBe(true);
  });

  it("reports an already-expired token's revocation as a no-op rather than writing to the store", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const authz = createHmacAuthzPort("test-secret");
    const cap = await authz.issueCapability(principal, [{ kind: "read", ref: "query://s/x" }], {
      ttlSeconds: 1,
    });
    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));

    const result = await authz.revokeCapability(cap);
    expect(result).toEqual({ ok: false, reason: "capability expired" });
  });

  it("actually consults an injected revocation store", async () => {
    const calls: string[] = [];
    const revocations: CapabilityRevocationStore = {
      async revoke(jti) {
        calls.push(`revoke:${jti}`);
      },
      async isRevoked(jti) {
        calls.push(`isRevoked:${jti}`);
        return calls.some((c) => c === `revoke:${jti}`);
      },
    };
    const authz = createHmacAuthzPort("test-secret", { revocations });
    const cap = await authz.issueCapability(principal, [{ kind: "read", ref: "query://s/x" }]);

    await authz.verify(cap, { kind: "read", ref: "query://s/x" });
    await authz.revokeCapability(cap);
    const result = await authz.verify(cap, { kind: "read", ref: "query://s/x" });

    expect(result.ok).toBe(false);
    expect(calls.some((c) => c.startsWith("isRevoked:"))).toBe(true);
    expect(calls.some((c) => c.startsWith("revoke:"))).toBe(true);
  });
});

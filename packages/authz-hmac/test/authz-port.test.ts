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

describe("createHmacAuthzPort tenant claim (SPEC CAP-TEN-001)", () => {
  const principal = { id: "u", roles: ["user"] };
  const scopes = [{ kind: "read" as const, ref: "query://s/x" }];
  const req = { kind: "read" as const, ref: "query://s/x" };

  it("signs opts.tenant into the token and returns it from verify", async () => {
    const authz = createHmacAuthzPort("test-secret");
    const cap = await authz.issueCapability(principal, scopes, { tenant: "acme" });
    expect(await authz.verify(cap, req)).toEqual({ ok: true, principal: { id: "u" }, tenant: "acme" });
  });

  it("never signs an empty tenant (it is no tenant)", async () => {
    const authz = createHmacAuthzPort("test-secret");
    const cap = await authz.issueCapability(principal, scopes, { tenant: "" });
    expect(await authz.verify(cap, req)).toEqual({ ok: true, principal: { id: "u" } });
  });

  it("treats a tenant-less (pre-upgrade) token as valid with no tenant by default", async () => {
    const authz = createHmacAuthzPort("test-secret");
    const cap = issueJtiLessToken("test-secret", "u", Math.floor(Date.now() / 1000) + 60);
    expect(await authz.verify(cap, req)).toEqual({ ok: true, principal: { id: "u" } });
  });

  it("requireTenant rejects a token without a tenant claim and accepts one with it", async () => {
    const authz = createHmacAuthzPort("test-secret", { requireTenant: true });
    const without = await authz.issueCapability(principal, scopes);
    expect(await authz.verify(without, req)).toEqual({ ok: false, reason: "capability lacks tenant" });
    const withTenant = await authz.issueCapability(principal, scopes, { tenant: "acme" });
    expect((await authz.verify(withTenant, req)).ok).toBe(true);
  });

  it("rejects a token whose payload was edited to carry another tenant (signature covers the claim)", async () => {
    const authz = createHmacAuthzPort("test-secret");
    const cap = await authz.issueCapability(principal, scopes, { tenant: "acme" });
    const [payload, signature] = cap.split(".") as [string, string];
    const edited = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), tenant: "evil" }),
    ).toString("base64url");
    expect((await authz.verify(`${edited}.${signature}`, req)).ok).toBe(false);
  });
});

describe("createHmacAuthzPort cross-language wire token (SPEC CAP-TEN-001)", () => {
  // The identical literal is verified by the Python test python/kohaku/tests/authz_hmac/test_authz_port.py
  // ("TS-issued wire token"): payload {sub, scopes, exp, jti, tenant}, HMAC-SHA256 over the payload string,
  // secret "interop-secret". The byte-level issue-side golden for the current Python port (`authzHmac` in
  // spec/test/fixtures/cross-language-canonical.json) is asserted by spec/test/cross-language.test.ts.
  const WIRE_TOKEN =
    "eyJzdWIiOiJpbnRlcm9wLXVzZXIiLCJzY29wZXMiOlt7ImtpbmQiOiJyZWFkIiwicmVmIjoicXVlcnk6Ly9zYWxlcy9zdW1tYXJ5P2Z5PTIwMjYifV0sImV4cCI6NDEwMjQ0NDgwMCwianRpIjoiaW50ZXJvcC1qdGkiLCJ0ZW5hbnQiOiJhY21lIn0.pT4L2fW_JAjOiuJ-e6S_kuhepszrDrl7fJZwHhY6hj4";

  it("verifies the shared wire token and reads its tenant", async () => {
    const authz = createHmacAuthzPort("interop-secret");
    expect(await authz.verify(WIRE_TOKEN, { kind: "read", ref: "query://sales/summary?fy=2026" })).toEqual({
      ok: true,
      principal: { id: "interop-user" },
      tenant: "acme",
    });
  });

  it("issues the claims in the documented order (sub, scopes, exp, jti, tenant)", async () => {
    const authz = createHmacAuthzPort("interop-secret");
    const cap = await authz.issueCapability({ id: "u" }, [{ kind: "read", ref: "query://s/x" }], {
      tenant: "acme",
    });
    const claims = JSON.parse(Buffer.from(cap.split(".")[0]!, "base64url").toString("utf8")) as object;
    expect(Object.keys(claims)).toEqual(["sub", "scopes", "exp", "jti", "tenant"]);
  });
});

describe("createHmacAuthzPort tenant claim validation and the Python-issued wire token", () => {
  const secret = "test-secret";
  const req = { kind: "read" as const, ref: "query://s/x" };

  /** A correctly signed token carrying exactly these claims (what a foreign issuer could mint). */
  function signedWith(claims: Record<string, unknown>): string {
    const payload = Buffer.from(
      JSON.stringify({
        sub: "u",
        scopes: [{ kind: "read", ref: "query://s/x" }],
        exp: 4102444800,
        ...claims,
      }),
    ).toString("base64url");
    return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
  }

  it("rejects an explicit null tenant claim as malformed (absent is fine)", async () => {
    const authz = createHmacAuthzPort(secret);
    expect(await authz.verify(signedWith({ tenant: null }), req)).toEqual({
      ok: false,
      reason: "malformed payload",
    });
    expect((await authz.verify(signedWith({}), req)).ok).toBe(true);
  });

  it("rejects an over-long or control-character tenant when verifying", async () => {
    const authz = createHmacAuthzPort(secret);
    expect((await authz.verify(signedWith({ tenant: "a".repeat(256) }), req)).ok).toBe(true);
    for (const tenant of ["a".repeat(257), "ac\nme", "ac\u0000me", "ac\u007fme"]) {
      expect(await authz.verify(signedWith({ tenant }), req)).toEqual({
        ok: false,
        reason: "malformed payload",
      });
    }
  });

  it("refuses to issue an over-long or control-character tenant", async () => {
    const authz = createHmacAuthzPort(secret);
    for (const tenant of ["a".repeat(257), "ac\nme"]) {
      await expect(authz.issueCapability({ id: "u" }, [], { tenant })).rejects.toThrow(/tenant/);
    }
    await expect(authz.issueCapability({ id: "u" }, [], { tenant: "a".repeat(256) })).resolves.toBeTypeOf(
      "string",
    );
  });

  it("verifies a jti-less token with the tenant claim, as the former Python sales-api port issued (secret interop-secret, tenant acme)", async () => {
    // Issued by the Python sales-api port before it moved into kohaku.authz_hmac (no jti; claims
    // sub/scopes/exp/tenant). Kept as a regression for the pre-upgrade (jti-less) shape; the current Python
    // port's issued bytes are pinned by the `authzHmac` cross-language golden instead.
    const token =
      "eyJzdWIiOiJweS11c2VyIiwic2NvcGVzIjpbeyJraW5kIjoicmVhZCIsInJlZiI6InF1ZXJ5Oi8vc2FsZXMvc3VtbWFyeT9meT0yMDI2In1dLCJleHAiOjQxMDI0NDQ4MDAsInRlbmFudCI6ImFjbWUifQ.vf71x9NdeJ2ilagq-UuWcnUBzwzfT6zuFCqA8q-sKEk";
    const authz = createHmacAuthzPort("interop-secret");
    expect(await authz.verify(token, { kind: "read", ref: "query://sales/summary?fy=2026" })).toEqual({
      ok: true,
      principal: { id: "py-user" },
      tenant: "acme",
    });
  });
});

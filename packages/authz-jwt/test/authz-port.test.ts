import { DEFAULT_CAPABILITY_TTL_SECONDS } from "@kohaku-ui/authz-hmac";
import { describeAuthzPortContract } from "@kohaku-ui/port-contracts";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJwtAuthzPort } from "../src/index.js";

const SECRET = "test-secret-at-least-32-bytes-long-000";

describe("createJwtAuthzPort", () => {
  const port = createJwtAuthzPort({
    key: { secret: SECRET },
    capabilitySecret: "cap-secret",
    capabilityTtlSeconds: 60,
  });

  it("issues and verifies HMAC capabilities exactly like @kohaku-ui/authz-hmac (delegation)", async () => {
    const token = await port.issueCapability({ id: "u1" }, [{ kind: "read", ref: "query://sales/x" }]);
    expect(await port.verify(token, { kind: "read", ref: "query://sales/x" })).toMatchObject({
      ok: true,
      principal: { id: "u1" },
    });
    expect((await port.verify(token, { kind: "write", ref: "annotate" })).ok).toBe(false);
  });

  it("exposes the identity resolver used to turn a bearer JWT into a principal", async () => {
    const jwt = await new SignJWT({ sub: "u9", roles: ["admin"] })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(SECRET));
    expect((await port.identity.fromAuthorizationHeader(`Bearer ${jwt}`)).principal.roles).toEqual(["admin"]);
  });
});

describe("createJwtAuthzPort capability tenant (delegated to authz-hmac)", () => {
  const scopes = [{ kind: "read" as const, ref: "query://sales/x" }];
  const req = { kind: "read" as const, ref: "query://sales/x" };

  it("round-trips opts.tenant through issue and verify", async () => {
    const port = createJwtAuthzPort({ key: { secret: SECRET }, capabilitySecret: "cap-secret" });
    const token = await port.issueCapability({ id: "u1" }, scopes, { tenant: "acme" });
    expect(await port.verify(token, req)).toMatchObject({ ok: true, tenant: "acme" });
  });

  it("requireCapabilityTenant rejects a tenant-less capability, independent of the JWT's own requireTenant", async () => {
    const port = createJwtAuthzPort({
      key: { secret: SECRET },
      capabilitySecret: "cap-secret",
      requireCapabilityTenant: true,
    });
    const without = await port.issueCapability({ id: "u1" }, scopes);
    expect(await port.verify(without, req)).toEqual({ ok: false, reason: "capability lacks tenant" });
    const withTenant = await port.issueCapability({ id: "u1" }, scopes, { tenant: "acme" });
    expect((await port.verify(withTenant, req)).ok).toBe(true);

    const lenient = createJwtAuthzPort({ key: { secret: SECRET }, capabilitySecret: "cap-secret" });
    expect((await lenient.verify(await lenient.issueCapability({ id: "u1" }, scopes), req)).ok).toBe(true);
  });
});

describe("createJwtAuthzPort (default capability TTL)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues capabilities with authz-hmac's DEFAULT_CAPABILITY_TTL_SECONDS when capabilityTtlSeconds is omitted", async () => {
    const port = createJwtAuthzPort({ key: { secret: SECRET }, capabilitySecret: "cap-secret" });
    const token = await port.issueCapability({ id: "u1" }, [{ kind: "read", ref: "query://sales/x" }]);

    vi.setSystemTime(new Date(Date.now() + (DEFAULT_CAPABILITY_TTL_SECONDS - 1) * 1000));
    expect((await port.verify(token, { kind: "read", ref: "query://sales/x" })).ok).toBe(true);

    vi.setSystemTime(new Date(Date.now() + 2000));
    expect((await port.verify(token, { kind: "read", ref: "query://sales/x" })).ok).toBe(false);
  });
});

describe("createJwtAuthzPort capability revocation (delegated to authz-hmac)", () => {
  it("verifies ok, then reports revoked once revokeCapability has been called through the JWT port", async () => {
    const port = createJwtAuthzPort({ key: { secret: SECRET }, capabilitySecret: "cap-secret" });
    const cap = await port.issueCapability({ id: "u1" }, [{ kind: "read", ref: "query://sales/x" }]);

    expect((await port.verify(cap, { kind: "read", ref: "query://sales/x" })).ok).toBe(true);

    const revoked = await port.revokeCapability(cap);
    expect(revoked).toEqual({ ok: true });

    const result = await port.verify(cap, { kind: "read", ref: "query://sales/x" });
    expect(result).toEqual({ ok: false, reason: "capability revoked" });
  });
});

describeAuthzPortContract(
  "jwt (capabilities via authz-hmac)",
  async () => ({
    port: createJwtAuthzPort({ key: { secret: SECRET }, capabilitySecret: "cap-secret" }),
  }),
  { revocation: true, tenant: true },
);

import { createJwtAuthzPort } from "@kohaku-ui/authz-jwt";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { createMemoryStoragePort } from "@kohaku-ui/storage-memory";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createJwtRequestIdentity } from "../src/app/request-identity.js";
import { createApp } from "../src/app.js";

const SECRET = "test-secret-at-least-32-bytes-long-000";

async function jwt(claims: Record<string, unknown>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(SECRET));
}

async function makeApp(opts: { demoAdminRoutes?: boolean } = {}) {
  const authz = createJwtAuthzPort({ key: { secret: SECRET }, capabilitySecret: "cap" });
  const storage = createMemoryStoragePort();
  const { app } = await createApp({
    llm: new FakeLlm(),
    storage,
    authz,
    identity: createJwtRequestIdentity(authz.identity),
    ...(opts.demoAdminRoutes != null ? { demoAdminRoutes: opts.demoAdminRoutes } : {}),
  });
  return { app, storage };
}

const QUARTERLY_GUI = {
  input: {
    kind: "gui",
    action: "view.select",
    params: { intent: "sales.quarterly_summary", fiscalYear: 2026, quarter: 3, groupBy: "region" },
  },
};

describe("sample-api with KOHAKU_AUTHZ=jwt wiring", () => {
  it("rejects a request without a bearer token with 401 and the error envelope", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/kohaku/catalog");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CAPABILITY_DENIED");
  });

  it("derives roles from the token: a viewer cannot approve, an admin can list promotions", async () => {
    const { app } = await makeApp();
    const viewer = await jwt({ sub: "v", roles: ["viewer"] });
    const admin = await jwt({ sub: "a", roles: ["admin"] });
    const evaluate = (token: string) =>
      app.request("/api/kohaku/promotions/evaluate", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await evaluate(viewer)).status).toBe(403);
    expect((await evaluate(admin)).status).toBe(200);
  });

  it("derives the tenant from the token and ignores x-kohaku-tenant", async () => {
    const { app, storage } = await makeApp();
    const token = await jwt({ sub: "u", roles: ["admin"], tenant: "acme" });
    const res = await app.request("/api/kohaku/compose", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-kohaku-tenant": "spoofed",
      },
      body: JSON.stringify(QUARTERLY_GUI),
    });
    expect(res.status).toBe(200);
    const composed = await storage.listLineage({ type: ["view.composed"] });
    expect(composed[0]!.tenant).toBe("acme");
  });

  it("has no tenant when the token carries none, even with x-kohaku-tenant present (headers are never trusted)", async () => {
    const { app, storage } = await makeApp();
    const token = await jwt({ sub: "u", roles: ["admin"] });
    const res = await app.request("/api/kohaku/compose", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-kohaku-tenant": "spoofed",
      },
      body: JSON.stringify(QUARTERLY_GUI),
    });
    expect(res.status).toBe(200);
    const composed = await storage.listLineage({ type: ["view.composed"] });
    expect(composed[0]!.tenant).toBeUndefined();
  });

  describe("the demo-only bump-data-version route (opt-in under JWT)", () => {
    it("is not registered by default, even for an admin token (404, not 401/403)", async () => {
      const { app } = await makeApp();
      const admin = await jwt({ sub: "a", roles: ["admin"] });
      const res = await app.request("/api/kohaku/admin/bump-data-version", {
        method: "POST",
        headers: { authorization: `Bearer ${admin}` },
      });
      expect(res.status).toBe(404);
    });

    it("with demoAdminRoutes:true, requires a bearer token (401) and then honors admin RBAC (200)", async () => {
      const { app } = await makeApp({ demoAdminRoutes: true });

      const noToken = await app.request("/api/kohaku/admin/bump-data-version", { method: "POST" });
      expect(noToken.status).toBe(401);
      expect(((await noToken.json()) as { error: { code: string } }).error.code).toBe("CAPABILITY_DENIED");

      const admin = await jwt({ sub: "a", roles: ["admin"] });
      const res = await app.request("/api/kohaku/admin/bump-data-version", {
        method: "POST",
        headers: { authorization: `Bearer ${admin}` },
      });
      expect(res.status).toBe(200);
      expect(typeof ((await res.json()) as { dataVersion: string }).dataVersion).toBe("string");
    });
  });
});

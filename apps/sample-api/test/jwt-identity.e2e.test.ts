import { createHmacApprovalPort, createMemoryApprovalStore } from "@kohaku-ui/authz-hmac";
import { createJwtAuthzPort } from "@kohaku-ui/authz-jwt";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { KohakuPolicyFile, LineageEventRecord, UISpec } from "@kohaku-ui/spec-core";
import { createMemoryStoragePort } from "@kohaku-ui/storage-memory";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createJwtRequestIdentity } from "../src/app/request-identity-jwt.js";
import { createApp } from "../src/app.js";

const SECRET = "test-secret-at-least-32-bytes-long-000";

async function jwt(claims: Record<string, unknown>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(SECRET));
}

async function makeApp(
  opts: {
    demoAdminRoutes?: boolean;
    approvals?: boolean;
    policyFile?: KohakuPolicyFile;
    requireCapabilityTenant?: boolean;
  } = {},
) {
  const authz = createJwtAuthzPort({
    key: { secret: SECRET },
    capabilitySecret: "cap",
    ...(opts.requireCapabilityTenant === true ? { requireCapabilityTenant: true } : {}),
  });
  const storage = createMemoryStoragePort();
  const { app } = await createApp({
    llm: new FakeLlm(),
    storage,
    authz,
    identity: createJwtRequestIdentity(authz.identity),
    ...(opts.demoAdminRoutes != null ? { demoAdminRoutes: opts.demoAdminRoutes } : {}),
    ...(opts.approvals === true
      ? { approvals: createHmacApprovalPort("cap", { store: createMemoryApprovalStore() }) }
      : {}),
    ...(opts.policyFile != null ? { policyFile: opts.policyFile } : {}),
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

  it("keeps the data plane alive: the HMAC capability from /compose (not a JWS) resolves /binding/resolve, and no Authorization is still 401", async () => {
    const { app } = await makeApp();
    const token = await jwt({ sub: "u", roles: ["admin"] });
    const composeRes = await app.request("/api/kohaku/compose", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(QUARTERLY_GUI),
    });
    expect(composeRes.status).toBe(200);
    const composed = (await composeRes.json()) as { spec: UISpec; capability: string };
    const ref = composed.spec.components.find((c) => c.data != null)!.data!.$ref;
    const resolveUrl = `/api/kohaku/binding/resolve?ref=${encodeURIComponent(ref)}`;

    // The data-binding client sends the capability (an HMAC token, not a JWT) in the Authorization header.
    const ok = await app.request(resolveUrl, { headers: { authorization: `Bearer ${composed.capability}` } });
    expect(ok.status).toBe(200);

    // The route stays fail-closed: no Authorization at all is rejected by host-rest's own capability check.
    const missing = await app.request(resolveUrl);
    expect(missing.status).toBe(401);

    // A bearer that is neither a valid capability nor anything else the data plane accepts is still denied.
    const bogus = await app.request(resolveUrl, { headers: { authorization: `Bearer ${token}` } });
    expect(bogus.status).toBeGreaterThanOrEqual(401);
    expect(bogus.status).toBeLessThan(500);
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

  describe("the data plane under JWT: the capability carries the tenant (SPEC CAP-TEN-001)", () => {
    const RECORDS_GUI = {
      input: { kind: "gui", action: "view.select", params: { intent: "sales.records" } },
    };

    async function composeAs(app: Awaited<ReturnType<typeof makeApp>>["app"], token: string) {
      const res = await app.request("/api/kohaku/compose", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(RECORDS_GUI),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { spec: UISpec; capability: string };
    }

    it("an approve-tier Action runs end to end: tenant-T requester composes, the approver approves, the token is accepted", async () => {
      const { app } = await makeApp({ approvals: true });
      const requester = await jwt({ sub: "req", roles: ["viewer"], tenant: "acme" });
      const approver = await jwt({ sub: "apr", roles: ["approver"], tenant: "acme" });
      const { capability } = await composeAs(app, requester);
      const payload = { action: "publish" };
      const invoke = (approval?: string) =>
        app.request("/api/kohaku/binding/action", {
          method: "POST",
          headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
          body: JSON.stringify({ action: "publish", payload, ...(approval != null ? { approval } : {}) }),
        });

      const first = await invoke();
      expect(first.status).toBe(403);
      const { error } = (await first.json()) as { error: { code: string; approval: { payloadHash: string } } };
      expect(error.code).toBe("APPROVAL_REQUIRED");

      const minted = await app.request("/api/kohaku/approvals", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${approver}` },
        body: JSON.stringify({ action: "publish", payloadHash: error.approval.payloadHash, requesterId: "req" }),
      });
      expect(minted.status).toBe(200);
      const { approval } = (await minted.json()) as { approval: string };

      const approved = await invoke(approval);
      expect(approved.status).toBe(200);
    });

    it("keys the /binding/action rate limit by the capability's tenant and sub, not the demo principal", async () => {
      const policyFile: KohakuPolicyFile = {
        version: 1,
        defaults: {},
        tenants: { acme: { rateLimits: { action: { capacity: 1, refillPerSecond: 0.001 } } } },
      };
      const { app } = await makeApp({ approvals: true, policyFile });
      const first = await composeAs(app, await jwt({ sub: "u1", roles: ["viewer"], tenant: "acme" }));
      const second = await composeAs(app, await jwt({ sub: "u2", roles: ["viewer"], tenant: "acme" }));
      const act = (capability: string) =>
        app.request("/api/kohaku/binding/action", {
          method: "POST",
          headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
          body: JSON.stringify({ action: "publish", payload: { action: "publish" } }),
        });

      expect((await act(first.capability)).status).toBe(403); // APPROVAL_REQUIRED, but past the limiter
      expect((await act(first.capability)).status).toBe(429); // u1's bucket (tenant acme, class action) is spent
      expect((await act(second.capability)).status).toBe(403); // u2 has its own bucket
    });

    it("requireCapabilityTenant: a compose with a tenant-less JWT yields a capability the data plane refuses", async () => {
      const { app } = await makeApp({ requireCapabilityTenant: true });
      const { spec, capability } = await composeAs(app, await jwt({ sub: "u", roles: ["viewer"] }));
      const ref = spec.components.find((c) => c.data != null)!.data!.$ref;
      const res = await app.request(`/api/kohaku/binding/resolve?ref=${encodeURIComponent(ref)}`, {
        headers: { authorization: `Bearer ${capability}` },
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CAPABILITY_DENIED");
    });
  });
});

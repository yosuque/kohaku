import { createJwtAuthzPort } from "@kohaku-ui/authz-jwt";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { createMemoryStoragePort } from "@kohaku-ui/storage-memory";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createJwtRequestIdentity } from "../src/ports/from-env.js";

const SECRET = "test-secret-at-least-32-bytes-long-000";

async function jwt(claims: Record<string, unknown>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(SECRET));
}

async function makeApp() {
  const authz = createJwtAuthzPort({ key: { secret: SECRET }, capabilitySecret: "cap" });
  const storage = createMemoryStoragePort();
  const { app } = await createApp({
    llm: new FakeLlm(),
    storage,
    authz,
    identity: createJwtRequestIdentity(authz.identity),
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
});

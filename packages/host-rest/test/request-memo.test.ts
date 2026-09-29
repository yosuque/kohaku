import type { ComposeContext } from "@kohaku-ui/composer";
import type { AuthzPort, DomainPort } from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import { createKohakuRoutes, type FixationsApi, type KohakuHostDeps } from "../src/index.js";

const NO_COMPOSE = {} as unknown as ComposeContext;

const authz: AuthzPort = {
  async issueCapability() {
    return "cap";
  },
  async verify() {
    return { ok: true, principal: { id: "u1", roles: ["user"] } };
  },
};

const domain: DomainPort = {
  async listOperations() {
    return [{ name: "annotate", description: "d" }];
  },
  async invoke() {
    return { ok: true };
  },
};

function deps(extra: Partial<KohakuHostDeps>): KohakuHostDeps {
  return { compose: NO_COMPOSE, domain, authz, querySource: "sales", ...extra };
}

describe("per-request principal / tenant memoization", () => {
  it("calls deps.auth and deps.tenant once for a request that asks for them at several places", async () => {
    const auth = vi.fn(async () => ({ id: "approver", roles: ["approver"] }));
    const tenant = vi.fn(async () => "t1");
    const app = createKohakuRoutes(
      deps({
        auth,
        tenant,
        authorizeGovernance: async () => true,
        fixations: {} as unknown as FixationsApi,
      }),
    );
    // requireGovernance (principal + tenant) and the handler (principal + tenant) both resolve them.
    const res = await app.request("/fixations/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    expect(auth).toHaveBeenCalledTimes(1);
    expect(tenant).toHaveBeenCalledTimes(1);
  });

  it("does not share a memo across requests", async () => {
    const auth = vi.fn(async () => ({ id: "u", roles: [] }));
    const app = createKohakuRoutes(
      deps({ auth, authorizeGovernance: async () => true, fixations: {} as unknown as FixationsApi }),
    );
    for (let i = 0; i < 2; i++) {
      await app.request("/fixations/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    }
    expect(auth).toHaveBeenCalledTimes(2);
  });

  it("the rate-limit middleware and the handler share one tenant lookup on /binding/action", async () => {
    const tenant = vi.fn(async () => "t1");
    const app = createKohakuRoutes(
      deps({
        tenant,
        rateLimiter: { take: async () => ({ allow: true }) },
      }),
    );
    const res = await app.request("/binding/action", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer cap" },
      body: JSON.stringify({ action: "annotate", payload: {} }),
    });
    expect(res.status).toBe(200);
    expect(tenant).toHaveBeenCalledTimes(1);
  });
});

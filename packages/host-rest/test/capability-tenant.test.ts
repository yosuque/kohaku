import type { ComposeContext } from "@kohaku-ui/composer";
import type { PolicyRateLimiterTakeParams } from "@kohaku-ui/host-core";
import type {
  ApprovalPort,
  ApprovalVerifyResult,
  AuthzPort,
  DomainPort,
  InvocationContext,
  JsonObject,
  OperationDescriptor,
} from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps } from "../src/index.js";

// SPEC CAP-TEN-001: on the REST data plane (/binding/resolve, /binding/action) the tenant signed into the
// capability is authoritative over the one the request itself resolves (deps.tenant), a disagreement is a
// 403, a tenant-less (pre-upgrade) capability falls back to deps.tenant, and the rate-limit key is the
// verified (tenant, capability sub, routeClass), taken only after the capability verified.

const NO_COMPOSE = {} as unknown as ComposeContext;
const REF = "query://sales/summary?fy=2026";

/** An AuthzPort whose verify answers what the test scripts: principal `sub` and the bound `tenant`. */
function authzBinding(bound: { sub?: string; tenant?: string } | "deny"): AuthzPort {
  return {
    async issueCapability() {
      return "cap";
    },
    async verify() {
      if (bound === "deny") return { ok: false, reason: "invalid signature" };
      return {
        ok: true,
        principal: { id: bound.sub ?? "u1", roles: ["user"] },
        ...(bound.tenant != null ? { tenant: bound.tenant } : {}),
      };
    },
  };
}

interface Recording {
  domain: DomainPort;
  invocations: { op: string; args: JsonObject; ctx: InvocationContext }[];
}

function recordingDomain(...ops: OperationDescriptor[]): Recording {
  const invocations: Recording["invocations"] = [];
  return {
    invocations,
    domain: {
      async listOperations() {
        return ops;
      },
      async invoke(op, args, ctx) {
        invocations.push({ op, args, ctx });
        return { ok: true };
      },
    },
  };
}

const headerTenant = (c: { req: { header(n: string): string | undefined } }) =>
  c.req.header("x-kohaku-tenant") || undefined;

function depsWith(extra: Partial<KohakuHostDeps> & Pick<KohakuHostDeps, "authz" | "domain">): KohakuHostDeps {
  return { compose: NO_COMPOSE, querySource: "sales", ...extra };
}

async function resolve(deps: KohakuHostDeps, headers: Record<string, string> = {}) {
  return createKohakuRoutes(deps).request(`/binding/resolve?ref=${encodeURIComponent(REF)}`, {
    headers: { authorization: "Bearer cap", ...headers },
  });
}

async function act(deps: KohakuHostDeps, body: unknown, headers: Record<string, string> = {}) {
  return createKohakuRoutes(deps).request("/binding/action", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer cap", ...headers },
    body: JSON.stringify(body),
  });
}

describe("/binding/*: the capability's tenant is authoritative (CAP-TEN-001)", () => {
  it("resolve: the capability's tenant reaches the DomainPort even when deps.tenant resolves nothing", async () => {
    const rec = recordingDomain();
    const deps = depsWith({
      domain: rec.domain,
      authz: authzBinding({ tenant: "acme" }),
      tenant: headerTenant,
    });
    const res = await resolve(deps);
    expect(res.status).toBe(200);
    expect(rec.invocations[0]!.ctx.tenant).toBe("acme");
  });

  it("resolve: a request tenant equal to the capability's passes", async () => {
    const rec = recordingDomain();
    const deps = depsWith({
      domain: rec.domain,
      authz: authzBinding({ tenant: "acme" }),
      tenant: headerTenant,
    });
    const res = await resolve(deps, { "x-kohaku-tenant": "acme" });
    expect(res.status).toBe(200);
    expect(rec.invocations[0]!.ctx.tenant).toBe("acme");
  });

  it("resolve: a request tenant that disagrees with the capability's is 403 CAPABILITY_DENIED and never reaches the DomainPort", async () => {
    const rec = recordingDomain();
    const deps = depsWith({
      domain: rec.domain,
      authz: authzBinding({ tenant: "acme" }),
      tenant: headerTenant,
    });
    const res = await resolve(deps, { "x-kohaku-tenant": "globex" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("CAPABILITY_DENIED");
    expect(body.error.message).toBe("capability tenant does not match the request tenant");
    expect(rec.invocations).toHaveLength(0);
  });

  it("resolve: a tenant-less (pre-upgrade) capability falls back to deps.tenant", async () => {
    const rec = recordingDomain();
    const deps = depsWith({ domain: rec.domain, authz: authzBinding({}), tenant: headerTenant });
    const res = await resolve(deps, { "x-kohaku-tenant": "globex" });
    expect(res.status).toBe(200);
    expect(rec.invocations[0]!.ctx.tenant).toBe("globex");
  });

  it("resolve: no tenant anywhere leaves InvocationContext.tenant absent", async () => {
    const rec = recordingDomain();
    const res = await resolve(depsWith({ domain: rec.domain, authz: authzBinding({}) }));
    expect(res.status).toBe(200);
    expect("tenant" in rec.invocations[0]!.ctx).toBe(false);
  });

  it("action: the capability's tenant is passed to domain.invoke, the audit record and the approval binding", async () => {
    const rec = recordingDomain({ name: "delete", description: "d", tier: "approve" });
    const verifyApproval = vi.fn(
      async (
        _token: string,
        req: { action: string; payloadHash: string; requesterId: string; tenant?: string },
      ): Promise<ApprovalVerifyResult> => ({
        ok: true,
        grant: {
          action: req.action,
          payloadHash: req.payloadHash,
          approverId: "approver-1",
          requesterId: req.requesterId,
          exp: 9999999999,
          jti: "j",
        },
      }),
    );
    const approvals = { issueApproval: vi.fn(), verifyApproval } as unknown as ApprovalPort;
    const invoked = vi.fn(async (_args: { tenant?: string }) => {});
    const deps = depsWith({
      domain: rec.domain,
      authz: authzBinding({ tenant: "acme" }),
      approvals,
      tenant: headerTenant,
      actionAuditRecorder: {
        invoked,
        denied: async () => {},
        approvalRequested: async () => {},
        approved: async () => {},
      },
    });
    const res = await act(deps, { action: "delete", payload: {}, approval: "tok" });
    expect(res.status).toBe(200);
    expect(rec.invocations[0]!.ctx.tenant).toBe("acme");
    expect(verifyApproval.mock.calls[0]![1].tenant).toBe("acme");
    expect(invoked.mock.calls[0]![0].tenant).toBe("acme");
  });

  it("action: a mismatching request tenant is 403 before the gate or the DomainPort run", async () => {
    const rec = recordingDomain({ name: "annotate", description: "d" });
    const deps = depsWith({
      domain: rec.domain,
      authz: authzBinding({ tenant: "acme" }),
      tenant: headerTenant,
    });
    const res = await act(deps, { action: "annotate", payload: {} }, { "x-kohaku-tenant": "globex" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CAPABILITY_DENIED");
    expect(rec.invocations).toHaveLength(0);
  });

  it("action: a tenant-less capability uses deps.tenant for the domain invocation", async () => {
    const rec = recordingDomain({ name: "annotate", description: "d" });
    const deps = depsWith({ domain: rec.domain, authz: authzBinding({}), tenant: headerTenant });
    const res = await act(deps, { action: "annotate", payload: {} }, { "x-kohaku-tenant": "globex" });
    expect(res.status).toBe(200);
    expect(rec.invocations[0]!.ctx.tenant).toBe("globex");
  });
});

describe("/binding/*: rate limiting runs after verification, keyed by the capability", () => {
  function limiterRecording(allow = true) {
    const calls: PolicyRateLimiterTakeParams[] = [];
    return {
      calls,
      limiter: {
        async take(params: PolicyRateLimiterTakeParams) {
          calls.push(params);
          return allow ? { allow: true as const } : { allow: false as const, retryAfterMs: 1000 };
        },
      },
    };
  }

  it("resolve: counts (capability tenant, capability sub, 'resolve'), not the request headers' identity", async () => {
    const { calls, limiter } = limiterRecording();
    const deps = depsWith({
      domain: recordingDomain().domain,
      authz: authzBinding({ sub: "cap-user", tenant: "acme" }),
      rateLimiter: limiter,
      auth: async () => ({ id: "header-user", roles: ["admin"] }),
      tenant: headerTenant,
    });
    expect((await resolve(deps)).status).toBe(200);
    expect(calls).toEqual([{ tenant: "acme", principal: "cap-user", routeClass: "resolve" }]);
  });

  it("action: counts (capability tenant, capability sub, 'action')", async () => {
    const { calls, limiter } = limiterRecording();
    const deps = depsWith({
      domain: recordingDomain({ name: "annotate", description: "d" }).domain,
      authz: authzBinding({ sub: "cap-user", tenant: "acme" }),
      rateLimiter: limiter,
    });
    expect((await act(deps, { action: "annotate", payload: {} })).status).toBe(200);
    expect(calls).toEqual([{ tenant: "acme", principal: "cap-user", routeClass: "action" }]);
  });

  it("a denied capability never takes a token (the limiter is not consulted before verification)", async () => {
    const { calls, limiter } = limiterRecording();
    const deps = depsWith({
      domain: recordingDomain({ name: "annotate", description: "d" }).domain,
      authz: authzBinding("deny"),
      rateLimiter: limiter,
    });
    expect((await resolve(deps)).status).toBe(403);
    expect((await act(deps, { action: "annotate", payload: {} })).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("a missing bearer is 401 without consulting the limiter", async () => {
    const { calls, limiter } = limiterRecording(false);
    const deps = depsWith({
      domain: recordingDomain().domain,
      authz: authzBinding({}),
      rateLimiter: limiter,
    });
    const res = await createKohakuRoutes(deps).request(`/binding/resolve?ref=${encodeURIComponent(REF)}`);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("a denial is 429 RATE_LIMITED with Retry-After and notifies onRateLimited with the capability's identity", async () => {
    const { limiter } = limiterRecording(false);
    const onRateLimited = vi.fn();
    const rec = recordingDomain();
    const deps = depsWith({
      domain: rec.domain,
      authz: authzBinding({ sub: "cap-user", tenant: "acme" }),
      rateLimiter: limiter,
      onRateLimited,
    });
    const res = await resolve(deps);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(rec.invocations).toHaveLength(0);
    expect(onRateLimited).toHaveBeenCalledWith(
      expect.objectContaining({ tenant: "acme", principal: "cap-user", routeClass: "resolve" }),
    );
  });
});

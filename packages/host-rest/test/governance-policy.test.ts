import type { ComposeContext } from "@kohaku-ui/composer";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type { AuthzPort, DomainPort, Principal, SemanticPort, StoragePort } from "@kohaku-ui/spec-core";
import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import {
  createGovernancePolicy,
  createKohakuRoutes,
  type KohakuHostDeps,
  type PromotionsApi,
} from "../src/index.js";

// Tests for the declarative RBAC policy evaluator:
// - The evaluator in isolation (wildcard `*` / `<domain>.*` / exact match / deny / unknown role / role union)
// - Route integration (with x-kohaku-role-derived roles, viewer's approve -> 403, admin -> 200)

const DEMO_POLICY = {
  roles: {
    admin: ["*"],
    reviewer: ["promotion.*", "lineage.read"],
    viewer: ["lineage.read", "promotion.list", "promotion.get"],
  },
} as const;

function principal(...roles: string[]): Principal {
  return { id: `u-${roles.join("-")}`, roles };
}

describe("createGovernancePolicy (evaluator unit)", () => {
  const evaluate = createGovernancePolicy(DEMO_POLICY);

  it("`*` allows all operations (admin)", () => {
    expect(evaluate(principal("admin"), { kind: "promotion.approve" })).toBe(true);
    expect(evaluate(principal("admin"), { kind: "fixation.remove" })).toBe(true);
    expect(evaluate(principal("admin"), { kind: "lineage.read" })).toBe(true);
  });

  it("`<domain>.*` allows everything within the domain and denies outside it (reviewer)", () => {
    expect(evaluate(principal("reviewer"), { kind: "promotion.approve" })).toBe(true);
    expect(evaluate(principal("reviewer"), { kind: "promotion.list" })).toBe(true);
    expect(evaluate(principal("reviewer"), { kind: "lineage.read" })).toBe(true);
    // Outside the domain (fixation / telemetry) is denied.
    expect(evaluate(principal("reviewer"), { kind: "fixation.remove" })).toBe(false);
    expect(evaluate(principal("reviewer"), { kind: "telemetry.write" })).toBe(false);
  });

  it("allows only exact matches and denies everything else (viewer)", () => {
    expect(evaluate(principal("viewer"), { kind: "lineage.read" })).toBe(true);
    expect(evaluate(principal("viewer"), { kind: "promotion.list" })).toBe(true);
    // Approval / deletion kinds are denied.
    expect(evaluate(principal("viewer"), { kind: "promotion.approve" })).toBe(false);
    expect(evaluate(principal("viewer"), { kind: "fixation.approve" })).toBe(false);
  });

  it("denies unknown roles and no roles (deny-by-default)", () => {
    expect(evaluate(principal("guest"), { kind: "lineage.read" })).toBe(false);
    expect(evaluate({ id: "no-roles" }, { kind: "lineage.read" })).toBe(false);
    expect(evaluate({ id: "empty", roles: [] }, { kind: "lineage.read" })).toBe(false);
  });

  it("multiple roles are the union of permissions (allowed if any matches)", () => {
    // viewer alone is denied, but combined with reviewer, promotion.approve passes.
    expect(evaluate(principal("viewer", "reviewer"), { kind: "promotion.approve" })).toBe(true);
    // Even with an unknown role mixed in, the known role's permissions still apply.
    expect(evaluate(principal("guest", "viewer"), { kind: "lineage.read" })).toBe(true);
  });

  it("a kind outside the real set matches no pattern and is denied (except roles holding `*`)", () => {
    // Even if an unknown kind arrives via a typo, viewer denies it. Only admin (`*`) allows it (preserving the meaning of allow-all).
    expect(evaluate(principal("viewer"), { kind: "promotion.bogus" })).toBe(false);
    expect(evaluate(principal("admin"), { kind: "promotion.bogus" })).toBe(true);
  });
});

describe("createGovernancePolicy with tenantOf (§4.4 Minor: tenant-aware governance)", () => {
  // admin owns tenant "acme". Without tenantOf, admin's `*` would reach any tenant's governance plane
  // (the historical role-only scope note); with tenantOf wired, a mismatched tenant must be denied outright.
  const evaluate = createGovernancePolicy({ ...DEMO_POLICY, tenantOf: () => "acme" });

  it("allows when the resolved tenant matches tenantOf(principal), even for a `*` role", () => {
    expect(evaluate(principal("admin"), { kind: "promotion.approve" }, "acme")).toBe(true);
  });

  it("denies when the resolved tenant does not match tenantOf(principal), regardless of role", () => {
    expect(evaluate(principal("admin"), { kind: "promotion.approve" }, "globex")).toBe(false);
    expect(evaluate(principal("admin"), { kind: "lineage.read" }, "globex")).toBe(false);
  });

  it('denies when no tenant is resolved but tenantOf(principal) returns one (undefined !== "acme")', () => {
    expect(evaluate(principal("admin"), { kind: "promotion.approve" })).toBe(false);
  });

  it("without tenantOf, a role grant reaches any tenant (unchanged historical behavior)", () => {
    const roleOnly = createGovernancePolicy(DEMO_POLICY);
    expect(roleOnly(principal("admin"), { kind: "promotion.approve" }, "globex")).toBe(true);
  });
});

// --- Route integration (wire the evaluator into authorizeGovernance) --------------------

const catalog = resolveCatalog(coreCatalog);

function stubSemantic(): SemanticPort {
  return {
    async normalize() {
      return { canonical: "sales.trend", params: {}, hash: "" };
    },
    async resolveQuery() {
      return { uri: "query://sales/summary?fy=2026" };
    },
    async dataVersion() {
      return "sales@v1";
    },
  };
}

function stubStorage(): StoragePort {
  return {
    async getSpecCache() {
      return null;
    },
    async putSpecCache() {},
    async appendLineage() {},
    async listLineage() {
      return [];
    },
    async getPromotionState() {
      return null;
    },
    async putPromotionState() {},
    async listPromotionStates() {
      return [];
    },
    async getFixation() {
      return null;
    },
    async putFixation() {},
    async listFixations() {
      return [];
    },
  };
}

function allowAuthz(): AuthzPort {
  return {
    async issueCapability() {
      return "cap";
    },
    async verify() {
      return { ok: true, principal: { id: "u", roles: ["user"] } };
    },
  };
}

const domain: DomainPort = {
  async listOperations() {
    return [];
  },
  async invoke() {
    return {};
  },
};

function composeCtx(): ComposeContext {
  return { catalog, semantic: stubSemantic(), storage: stubStorage(), llm: new FakeLlm(), policy: {} };
}

function trackedPromotions(): { api: PromotionsApi; calls: string[] } {
  const calls: string[] = [];
  const api: PromotionsApi = {
    async list() {
      calls.push("list");
      return [];
    },
    async evaluateAndList() {
      calls.push("evaluateAndList");
      return [];
    },
    async get(id) {
      calls.push("get");
      return { artifactId: id, status: "candidate" };
    },
    async act(id) {
      calls.push("act");
      return { artifactId: id, status: "acted" };
    },
    async approve(id) {
      calls.push("approve");
      return { artifactId: id, status: "published" };
    },
    async reject(id) {
      calls.push("reject");
      return { artifactId: id, status: "rejected" };
    },
    async withdraw(id) {
      calls.push("withdraw");
      return { artifactId: id, status: "withdrawn" };
    },
  };
  return { api, calls };
}

const draft = {
  componentType: "sales.customX",
  version: "1.0.0",
  intentName: "sales.customX",
  description: "test draft",
};

/** deps that resolve the role from the x-kohaku-role header and wire the declarative policy (defaults to admin). */
function roleDeps(promotions: PromotionsApi): KohakuHostDeps {
  return {
    compose: composeCtx(),
    domain,
    authz: allowAuthz(),
    querySource: "sales",
    auth: async (c: Context): Promise<Principal> => {
      const role = c.req.header("x-kohaku-role") || "admin";
      return { id: `demo-${role}`, roles: [role] };
    },
    authorizeGovernance: createGovernancePolicy(DEMO_POLICY),
    promotions,
  };
}

function reqRole(
  app: ReturnType<typeof createKohakuRoutes>,
  method: "GET" | "POST",
  path: string,
  role?: string,
  body?: unknown,
) {
  return app.request(path, {
    method,
    headers: {
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      ...(role != null ? { "x-kohaku-role": role } : {}),
    },
    ...(method === "POST" && body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("route integration of the declarative policy", () => {
  it("viewer's promotion approve is 403 CAPABILITY_DENIED (downstream approve is not called)", async () => {
    const promotions = trackedPromotions();
    const app = createKohakuRoutes(roleDeps(promotions.api));

    const res = await reqRole(app, "POST", "/promotions/known/approve", "viewer", { draft });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CAPABILITY_DENIED");
    expect(promotions.calls).not.toContain("approve");
  });

  it("even for viewer, reads (lineage.read / promotion.list) are 200", async () => {
    const promotions = trackedPromotions();
    const app = createKohakuRoutes(roleDeps(promotions.api));

    expect((await reqRole(app, "GET", "/lineage", "viewer")).status).toBe(200);
    expect((await reqRole(app, "GET", "/promotions", "viewer")).status).toBe(200);
  });

  it("admin's promotion approve is 200 (downstream approve is called)", async () => {
    const promotions = trackedPromotions();
    const app = createKohakuRoutes(roleDeps(promotions.api));

    const res = await reqRole(app, "POST", "/promotions/known/approve", "admin", { draft });
    expect(res.status).toBe(200);
    expect(promotions.calls).toContain("approve");
  });

  it("with no header specified (default admin), approve is 200 (regression of existing demo behavior)", async () => {
    const promotions = trackedPromotions();
    const app = createKohakuRoutes(roleDeps(promotions.api));

    const res = await reqRole(app, "POST", "/promotions/known/approve", undefined, { draft });
    expect(res.status).toBe(200);
    expect(promotions.calls).toContain("approve");
  });
});

describe("route integration of tenantOf (a role grant no longer crosses tenants)", () => {
  /** Same wiring as roleDeps, plus deps.tenant (x-kohaku-tenant header) and a policy whose tenantOf pins
   * every principal to tenant "acme" — a request resolving to any other tenant must be denied outright,
   * even for admin's `*` role grant. */
  function tenantAwareDeps(promotions: PromotionsApi): KohakuHostDeps {
    return {
      compose: composeCtx(),
      domain,
      authz: allowAuthz(),
      querySource: "sales",
      auth: async (c: Context): Promise<Principal> => {
        const role = c.req.header("x-kohaku-role") || "admin";
        return { id: `demo-${role}`, roles: [role] };
      },
      tenant: (c: Context) => c.req.header("x-kohaku-tenant") || undefined,
      authorizeGovernance: createGovernancePolicy({ ...DEMO_POLICY, tenantOf: () => "acme" }),
      promotions,
    };
  }

  function reqTenant(
    app: ReturnType<typeof createKohakuRoutes>,
    method: "GET" | "POST",
    path: string,
    tenant?: string,
    body?: unknown,
  ) {
    return app.request(path, {
      method,
      headers: {
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        ...(tenant != null ? { "x-kohaku-tenant": tenant } : {}),
      },
      ...(method === "POST" && body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  it("admin at its own tenant (acme) is 200", async () => {
    const promotions = trackedPromotions();
    const app = createKohakuRoutes(tenantAwareDeps(promotions.api));

    expect((await reqTenant(app, "GET", "/lineage", "acme")).status).toBe(200);
  });

  it("admin at a different tenant is 403 CAPABILITY_DENIED despite the `*` role grant", async () => {
    const promotions = trackedPromotions();
    const app = createKohakuRoutes(tenantAwareDeps(promotions.api));

    const res = await reqTenant(app, "GET", "/lineage", "globex");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CAPABILITY_DENIED");
  });

  it("a mismatched-tenant promotion approve is denied and the downstream approve is never called", async () => {
    const promotions = trackedPromotions();
    const app = createKohakuRoutes(tenantAwareDeps(promotions.api));

    const res = await reqTenant(app, "POST", "/promotions/known/approve", "globex", { draft });
    expect(res.status).toBe(403);
    expect(promotions.calls).not.toContain("approve");
  });
});

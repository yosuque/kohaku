import type { ComposeContext } from "@kohaku-ui/composer";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type { AuthzPort, DomainPort, Principal, SemanticPort, StoragePort } from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import {
  createKohakuRoutes,
  type FixationsApi,
  type KohakuHostDeps,
  type PromotionsApi,
} from "../src/index.js";

// host-rest wiring tests for the governance/audit-plane authorization hook:
// - authorizeGovernance is wired and denies -> 403 CAPABILITY_DENIED (the downstream API is not called).
// - allow -> passes through. Not wired -> legacy behavior (allowed without authorization).

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

/** An authorizeGovernance spy that records the invoked governance operations and makes allowed configurable. */
function spyGovernance(allowed: boolean): {
  hook: NonNullable<KohakuHostDeps["authorizeGovernance"]>;
  seen: { kind: string; artifactId?: string; intentHash?: string; principal: Principal; tenant?: string }[];
} {
  const seen: {
    kind: string;
    artifactId?: string;
    intentHash?: string;
    principal: Principal;
    tenant?: string;
  }[] = [];
  return {
    seen,
    hook: (principal, operation, tenant) => {
      seen.push({ ...operation, principal, ...(tenant != null ? { tenant } : {}) });
      return allowed;
    },
  };
}

/** A promotions fake that records when called (to verify the downstream is not called on deny). */
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
    async reconcile() {
      calls.push("reconcile");
      return { published: 0, withdrawn: 0, skipped: 0 };
    },
  };
  return { api, calls };
}

function trackedFixations(): { api: FixationsApi; calls: string[] } {
  const calls: string[] = [];
  const api: FixationsApi = {
    async proposals() {
      calls.push("proposals");
      return [];
    },
    async list() {
      calls.push("list");
      return [];
    },
    async fixate() {
      calls.push("fixate");
      return {};
    },
    async unfixate() {
      calls.push("unfixate");
    },
  };
  return { api, calls };
}

function makeDeps(overrides: Partial<KohakuHostDeps>): KohakuHostDeps {
  return {
    compose: composeCtx(),
    domain,
    authz: allowAuthz(),
    querySource: "sales",
    ...overrides,
  };
}

function post(app: ReturnType<typeof createKohakuRoutes>, path: string, body?: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const draft = {
  componentType: "sales.customX",
  version: "1.0.0",
  intentName: "sales.customX",
  description: "test draft",
};

async function expectDenied(res: { status: number; json(): Promise<unknown> }): Promise<void> {
  expect(res.status).toBe(403);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CAPABILITY_DENIED");
}

describe("authorization hook of the governance/audit plane (host-rest)", () => {
  it("on deny: every governance route returns 403 CAPABILITY_DENIED and does not call the downstream API", async () => {
    const gov = spyGovernance(false);
    const promotions = trackedPromotions();
    const fixations = trackedFixations();
    const app = createKohakuRoutes(
      makeDeps({ authorizeGovernance: gov.hook, promotions: promotions.api, fixations: fixations.api }),
    );

    await expectDenied(await app.request("/lineage"));
    await expectDenied(await post(app, "/telemetry", { events: [] }));
    await expectDenied(await app.request("/promotions"));
    await expectDenied(await post(app, "/promotions/evaluate"));
    await expectDenied(await post(app, "/promotions/reconcile"));
    await expectDenied(await app.request("/promotions/known"));
    await expectDenied(await post(app, "/promotions/known/preview"));
    await expectDenied(await post(app, "/promotions/known/approve", { draft }));
    await expectDenied(await post(app, "/promotions/known/reject", {}));
    await expectDenied(await post(app, "/promotions/known/withdraw", {}));
    await expectDenied(await post(app, "/promotions/known/actions", { action: { kind: "judge.start" } }));
    await expectDenied(await app.request("/fixations"));
    await expectDenied(await app.request("/fixations/proposals"));
    await expectDenied(await post(app, "/fixations/approve", { intent: { canonical: "x", params: {} } }));
    await expectDenied(await post(app, "/fixations/sha256:abc/remove"));

    // An authorization denial does not reach the downstream API (blocking side effects at the boundary).
    expect(promotions.calls).toHaveLength(0);
    expect(fixations.calls).toHaveLength(0);

    // operation.kind is passed correctly per route (with the target ID for identifier-bearing ones).
    const kinds = gov.seen.map((s) => s.kind);
    expect(kinds).toEqual([
      "lineage.read",
      "telemetry.write",
      "promotion.list",
      "promotion.evaluate",
      "promotion.reconcile",
      "promotion.get",
      "promotion.preview",
      "promotion.approve",
      "promotion.reject",
      "promotion.withdraw",
      "promotion.act",
      "fixation.list",
      "fixation.proposals",
      "fixation.approve",
      "fixation.remove",
    ]);
    expect(gov.seen.find((s) => s.kind === "promotion.approve")?.artifactId).toBe("known");
    expect(gov.seen.find((s) => s.kind === "fixation.remove")?.intentHash).toBe("sha256:abc");
  });

  it("on allow: governance routes are processed as usual and the downstream API is called", async () => {
    const gov = spyGovernance(true);
    const promotions = trackedPromotions();
    const app = createKohakuRoutes(makeDeps({ authorizeGovernance: gov.hook, promotions: promotions.api }));

    expect((await app.request("/lineage")).status).toBe(200);
    expect((await app.request("/promotions")).status).toBe(200);
    expect((await post(app, "/promotions/known/approve", { draft })).status).toBe(200);

    expect(promotions.calls).toContain("approve");
  });

  it("not wired: legacy behavior (allowed without authorization); guards regression of existing tests", async () => {
    const promotions = trackedPromotions();
    // No authorizeGovernance.
    const app = createKohakuRoutes(makeDeps({ promotions: promotions.api }));

    expect((await app.request("/lineage")).status).toBe(200);
    expect((await app.request("/promotions")).status).toBe(200);
  });

  it("promotion.act alone cannot publish/approve/reject/withdraw/judge via the generic actions route (403)", async () => {
    // Authorization allows only the blanket promotion.act kind; any action mirroring a dedicated named route
    // (or judge.result) additionally requires its own kind and must be denied here.
    const gov: NonNullable<KohakuHostDeps["authorizeGovernance"]> = (_p, operation) =>
      operation.kind === "promotion.act";
    const promotions = trackedPromotions();
    const app = createKohakuRoutes(makeDeps({ authorizeGovernance: gov, promotions: promotions.api }));

    await expectDenied(await post(app, "/promotions/known/actions", { action: { kind: "review.approve" } }));
    await expectDenied(
      await post(app, "/promotions/known/actions", { action: { kind: "publish", version: "1.0.0" } }),
    );
    await expectDenied(
      await post(app, "/promotions/known/actions", { action: { kind: "schema.propose", draft } }),
    );
    await expectDenied(await post(app, "/promotions/known/actions", { action: { kind: "review.reject" } }));
    await expectDenied(await post(app, "/promotions/known/actions", { action: { kind: "withdraw" } }));
    await expectDenied(await post(app, "/promotions/known/actions", { action: { kind: "unpublish" } }));
    await expectDenied(
      await post(app, "/promotions/known/actions", {
        action: { kind: "judge.result", verdict: { pass: true, score: 1 } },
      }),
    );

    // Kinds with no dedicated named route to mirror still pass with promotion.act alone.
    expect((await post(app, "/promotions/known/actions", { action: { kind: "nominate" } })).status).toBe(200);
    expect((await post(app, "/promotions/known/actions", { action: { kind: "judge.start" } })).status).toBe(
      200,
    );
    expect((await post(app, "/promotions/known/actions", { action: { kind: "review.start" } })).status).toBe(
      200,
    );

    expect(promotions.calls.filter((c) => c === "act")).toHaveLength(3);
  });

  it("judge.result via the actions route requires promotion.judge in addition to promotion.act", async () => {
    const gov: NonNullable<KohakuHostDeps["authorizeGovernance"]> = (_p, operation) =>
      operation.kind === "promotion.act" || operation.kind === "promotion.judge";
    const promotions = trackedPromotions();
    const app = createKohakuRoutes(makeDeps({ authorizeGovernance: gov, promotions: promotions.api }));

    const res = await post(app, "/promotions/known/actions", {
      action: { kind: "judge.result", verdict: { pass: true, score: 1 } },
    });
    expect(res.status).toBe(200);
    expect(promotions.calls).toContain("act");
  });
});

describe("startup warnings for unwired security-relevant hooks", () => {
  it("warns exactly once when authorizeGovernance is unwired, and not at all when wired", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    createKohakuRoutes(makeDeps({ auth: async () => ({ id: "u", roles: ["user"] }) }));
    expect(spy.mock.calls.filter((args) => String(args[0]).includes("Governance/audit routes"))).toHaveLength(
      1,
    );
    spy.mockClear();
    createKohakuRoutes(
      makeDeps({ authorizeGovernance: () => true, auth: async () => ({ id: "u", roles: ["user"] }) }),
    );
    expect(spy.mock.calls.some((args) => String(args[0]).includes("Governance/audit routes"))).toBe(false);
    spy.mockRestore();
  });

  it("warns exactly once when deps.auth is unwired, and not at all when wired", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    createKohakuRoutes(makeDeps({ authorizeGovernance: () => true }));
    expect(spy.mock.calls.filter((args) => String(args[0]).includes("deps.auth is not wired"))).toHaveLength(
      1,
    );
    spy.mockClear();
    createKohakuRoutes(
      makeDeps({ authorizeGovernance: () => true, auth: async () => ({ id: "u", roles: ["user"] }) }),
    );
    expect(spy.mock.calls.some((args) => String(args[0]).includes("deps.auth is not wired"))).toBe(false);
    spy.mockRestore();
  });
});

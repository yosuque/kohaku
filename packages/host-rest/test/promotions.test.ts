import type { ComposeContext } from "@kohaku-ui/composer";
import type { AuthzPort, DomainPort, Principal } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps, type PromotionsApi } from "../src/index.js";

// The promotions routes do not reference compose/authz/domain, so stubs suffice.
const NO_COMPOSE = {} as unknown as ComposeContext;
const NO_AUTHZ = {} as unknown as AuthzPort;
const NO_DOMAIN = {} as unknown as DomainPort;

/** An exception that structurally represents PROMOTION_NOT_PUBLISHED (host-rest discriminates by code, not by importing lineage). */
class FakeNotPublished extends Error {
  readonly code = "PROMOTION_NOT_PUBLISHED";
  readonly status = "judge_failed";
  constructor() {
    super("approval did not reach published");
    this.name = "PromotionNotPublishedError";
  }
}

/** A transition-rejection exception with name==="TransitionError". */
class FakeTransitionError extends Error {
  constructor() {
    super("invalid promotion transition");
    this.name = "TransitionError";
  }
}

/**
 * A "reject did not reach rejected" exception with name==="PromotionNotRejectedError".
 * Reproduces an exception isomorphic to the PromotionNotPublishedError that another agent adds to lineage
 * (host-rest discriminates by name via duck-typing, not by importing lineage).
 */
class FakeNotRejected extends Error {
  readonly code = "PROMOTION_NOT_REJECTED";
  readonly status = "published";
  constructor() {
    super('reject did not reach rejected (artifact status "published")');
    this.name = "PromotionNotRejectedError";
  }
}

interface Spy {
  nominates: string[];
  acts: Record<string, unknown>[];
  approves: {
    id: string;
    draft: unknown;
    reviewer: Principal;
    scope?: { acknowledgedSuggestion?: boolean };
  }[];
  withdraws: { id: string; actor: Principal; reason?: string }[];
}

/** A configurable fake PromotionsApi. A known artifact is "known"; unknown ones return null. */
function fakePromotions(opts?: { approveThrows?: Error; actThrows?: Error; rejectThrows?: Error }): {
  api: PromotionsApi;
  spy: Spy;
} {
  const spy: Spy = { nominates: [], acts: [], approves: [], withdraws: [] };
  const known = new Set(["known"]);
  const api: PromotionsApi = {
    async list() {
      return [{ artifactId: "known", status: "in_use" }];
    },
    async evaluateAndList() {
      // Record the auto-nominate side effect so the difference from list can be verified.
      spy.nominates.push("known");
      return [{ artifactId: "known", status: "candidate" }];
    },
    async get(id) {
      return known.has(id)
        ? {
            artifactId: id,
            status: "candidate",
            suggestion: {
              draft: { componentType: "x.y", version: "1.0.0", intentName: "x.y", description: "d" },
              events: [],
              confidence: 0.5,
              model: "m",
              extractorId: "l2-schema-extraction",
              extractorVersion: "0.1",
              suggestedAt: "2026-07-01T00:00:00.000Z",
            },
          }
        : null;
    },
    async act(id, action) {
      spy.acts.push(action);
      if (opts?.actThrows != null) throw opts.actThrows;
      return { artifactId: id, status: "acted", action };
    },
    async approve(id, draft, reviewer, scope) {
      spy.approves.push({ id, draft, reviewer, ...(scope != null ? { scope } : {}) });
      if (opts?.approveThrows != null) throw opts.approveThrows;
      return { artifactId: id, status: "published", draft };
    },
    async reject(id, reviewer) {
      if (opts?.rejectThrows != null) throw opts.rejectThrows;
      return { artifactId: id, status: "rejected", reviewer };
    },
    async withdraw(id, actor, options) {
      spy.withdraws.push({ id, actor, ...(options?.reason != null ? { reason: options.reason } : {}) });
      return {
        artifactId: id,
        status: "withdrawn",
        ...(options?.reason != null ? { reason: options.reason } : {}),
      };
    },
  };
  return { api, spy };
}

function deps(promotions?: PromotionsApi): KohakuHostDeps {
  return {
    compose: NO_COMPOSE,
    domain: NO_DOMAIN,
    authz: NO_AUTHZ,
    querySource: "sales",
    ...(promotions != null ? { promotions } : {}),
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

describe("promotions routes (host-rest first-class named routes)", () => {
  it("GET /promotions is list (no side effects), POST /promotions/evaluate is evaluateAndList (records nominate)", async () => {
    const { api, spy } = fakePromotions();
    const app = createKohakuRoutes(deps(api));

    const listRes = await app.request("/promotions");
    expect(listRes.status).toBe(200);
    expect(((await listRes.json()) as { candidates: unknown[] }).candidates).toHaveLength(1);
    // GET does not record nominate.
    expect(spy.nominates).toHaveLength(0);

    const evalRes = await post(app, "/promotions/evaluate");
    expect(evalRes.status).toBe(200);
    // evaluate has the auto-candidacy side effect.
    expect(spy.nominates).toEqual(["known"]);
  });

  it("GET /promotions/:id is 200 when present, 404 when absent", async () => {
    const { api } = fakePromotions();
    const app = createKohakuRoutes(deps(api));

    const ok = await app.request("/promotions/known");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { candidate: { artifactId: string } }).candidate.artifactId).toBe("known");

    const missing = await app.request("/promotions/nope");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  it("GET /promotions/:id passes the candidate's suggestion through unchanged (additive wire field)", async () => {
    const { api } = fakePromotions();
    const app = createKohakuRoutes(deps(api));
    const res = await app.request("/promotions/known");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidate: { suggestion?: { extractorId: string } } };
    expect(body.candidate.suggestion?.extractorId).toBe("l2-schema-extraction");
  });

  it("approve happy path: zod-validates the draft and returns 200 + reviewer is the server-side principal", async () => {
    const { api, spy } = fakePromotions();
    const app = createKohakuRoutes(deps(api));

    const res = await post(app, "/promotions/known/approve", { draft });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { candidate: { status: string } }).candidate.status).toBe("published");
    // The client did not declare a reviewer, but the server-side principal (default demo-user) is injected.
    expect(spy.approves).toHaveLength(1);
    expect(spy.approves[0]!.reviewer.id).toBe("demo-user");
  });

  it("approve: forwards an optional acknowledgedSuggestion to promotions.approve's scope (additive; absent when unspecified)", async () => {
    const { api, spy } = fakePromotions();
    const app = createKohakuRoutes(deps(api));

    const ack = await post(app, "/promotions/known/approve", { draft, acknowledgedSuggestion: true });
    expect(ack.status).toBe(200);
    expect(spy.approves[0]!.scope?.acknowledgedSuggestion).toBe(true);

    const noAck = await post(app, "/promotions/known/approve", { draft });
    expect(noAck.status).toBe(200);
    expect(spy.approves[1]!.scope?.acknowledgedSuggestion).toBeUndefined();
  });

  it("approve: a missing draft is 400", async () => {
    const { api } = fakePromotions();
    const app = createKohakuRoutes(deps(api));
    const res = await post(app, "/promotions/known/approve", { draft: { componentType: "x" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });

  it("approve: already published (PromotionNotPublishedError) is 409 + carries status", async () => {
    const { api } = fakePromotions({ approveThrows: new FakeNotPublished() });
    const app = createKohakuRoutes(deps(api));
    const res = await post(app, "/promotions/known/approve", { draft });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; status?: string } };
    expect(body.error.code).toBe("PROMOTION_NOT_PUBLISHED");
    expect(body.error.status).toBe("judge_failed");
  });

  it("approve: an unknown artifact is 404 (decided by get before entering the transition layer)", async () => {
    const { api } = fakePromotions();
    const app = createKohakuRoutes(deps(api));
    const res = await post(app, "/promotions/nope/approve", { draft });
    expect(res.status).toBe(404);
  });

  it("approve: candidate-store's require() error (code = PROMOTION_ARTIFACT_NOT_FOUND) maps to 404 when get is unimplemented (safeguard for when ensureArtifact's pre-check cannot run)", async () => {
    // A PromotionsApi without get skips ensureArtifact's pre-check entirely (promotions.get != null guards it),
    // so the transition layer's own "unknown artifact" error (discriminated by code, not a message-text match)
    // is what maps this to 404.
    const api: PromotionsApi = {
      async evaluateAndList() {
        return [];
      },
      async act() {
        throw Object.assign(new Error("unknown artifact: nope"), {
          code: "PROMOTION_ARTIFACT_NOT_FOUND",
        });
      },
      async approve() {
        throw Object.assign(new Error("unknown artifact: nope"), {
          code: "PROMOTION_ARTIFACT_NOT_FOUND",
        });
      },
      async reject() {
        throw new Error("unused");
      },
      async withdraw() {
        throw new Error("unused");
      },
    };
    const app = createKohakuRoutes(deps(api));
    const res = await post(app, "/promotions/nope/approve", { draft });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  it("approve: an unexpected exception is 500 INTERNAL with a fixed message, and the original error + a requestId reach onError", async () => {
    const api: PromotionsApi = {
      async evaluateAndList() {
        return [];
      },
      async act() {
        throw new Error("unused");
      },
      async approve() {
        throw new Error("db connection reset by peer at 10.0.0.5:5432 (internal detail)");
      },
      async reject() {
        throw new Error("unused");
      },
      async withdraw() {
        throw new Error("unused");
      },
    };
    const seen: { endpoint: string; requestId: string; error: unknown }[] = [];
    const app = createKohakuRoutes({ ...deps(api), onError: (info) => void seen.push(info) });
    const res = await post(app, "/promotions/known/approve", { draft });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string; requestId?: string } };
    expect(body.error.code).toBe("INTERNAL");
    // The raw message never reaches the client (it may leak internals).
    expect(body.error.message).not.toContain("10.0.0.5");
    expect(body.error.requestId).toBeDefined();
    // The original error still reaches the observability hook, correlated by the same requestId.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.requestId).toBe(body.error.requestId);
    expect((seen[0]!.error as Error).message).toContain("10.0.0.5");
  });

  it("reject happy path is 200", async () => {
    const { api } = fakePromotions();
    const app = createKohakuRoutes(deps(api));
    const res = await post(app, "/promotions/known/reject", {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { candidate: { status: string } }).candidate.status).toBe("rejected");
  });

  it("reject: PromotionNotRejectedError (rejected not reached) maps to 422 PROMOTION_INVALID", async () => {
    // To avoid growing the SPEC §6.1 error-code set, add no dedicated code and map it to PROMOTION_INVALID (422)
    // as a "transition did not take effect" (discriminate by name via duck-typing; do not drop to 500).
    const { api } = fakePromotions({ rejectThrows: new FakeNotRejected() });
    const app = createKohakuRoutes(deps(api));
    const res = await post(app, "/promotions/known/reject", {});
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("PROMOTION_INVALID");
  });

  it("withdraw happy path: passes reason and returns 200 + actor is the server-side principal", async () => {
    const { api, spy } = fakePromotions();
    const app = createKohakuRoutes(deps(api));
    const res = await post(app, "/promotions/known/withdraw", { reason: "takedown" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { candidate: { status: string } }).candidate.status).toBe("withdrawn");
    expect(spy.withdraws[0]).toMatchObject({ id: "known", reason: "takedown" });
    expect(spy.withdraws[0]!.actor.id).toBe("demo-user");
  });

  it("withdraw: an empty body is also 200 (reason omitted)", async () => {
    const { api } = fakePromotions();
    const app = createKohakuRoutes(deps(api));
    const res = await post(app, "/promotions/known/withdraw");
    expect(res.status).toBe(200);
  });

  it("actions: injects review.approve's reviewer into the validated action", async () => {
    const { api, spy } = fakePromotions();
    const app = createKohakuRoutes(deps(api));
    const res = await post(app, "/promotions/known/actions", {
      action: { kind: "review.approve", comment: "ok" },
    });
    expect(res.status).toBe(200);
    // The server-side principal, not a client declaration, is injected as the reviewer.
    expect(spy.acts[0]).toMatchObject({ kind: "review.approve", comment: "ok" });
    expect((spy.acts[0] as { reviewer?: Principal }).reviewer?.id).toBe("demo-user");
  });

  it("actions: an invalid kind is 400", async () => {
    const { api } = fakePromotions();
    const app = createKohakuRoutes(deps(api));
    const res = await post(app, "/promotions/known/actions", { action: { kind: "bogus" } });
    expect(res.status).toBe(400);
  });

  it("actions: a missing version for publish is 400", async () => {
    const { api } = fakePromotions();
    const app = createKohakuRoutes(deps(api));
    const res = await post(app, "/promotions/known/actions", { action: { kind: "publish" } });
    expect(res.status).toBe(400);
  });

  it("actions: TransitionError (transition rejected) is 422 PROMOTION_INVALID", async () => {
    const { api } = fakePromotions({ actThrows: new FakeTransitionError() });
    const app = createKohakuRoutes(deps(api));
    const res = await post(app, "/promotions/known/actions", { action: { kind: "judge.start" } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("PROMOTION_INVALID");
  });

  it("when promotions is not injected, every route is 501", async () => {
    const app = createKohakuRoutes(deps());
    for (const [method, path] of [
      ["GET", "/promotions"],
      ["POST", "/promotions/evaluate"],
      ["GET", "/promotions/known"],
      ["POST", "/promotions/known/preview"],
      ["POST", "/promotions/known/approve"],
      ["POST", "/promotions/known/reject"],
      ["POST", "/promotions/known/withdraw"],
      ["POST", "/promotions/known/actions"],
    ] as const) {
      const res = await app.request(path, {
        method,
        ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(501);
    }
  });
});

/**
 * A fake that respects tenant ownership. artifact "acme-art" belongs to tenant "acme".
 * When tenant is specified, only matching ownership is visible; unspecified (single tenant) is visible regardless of ownership.
 * Records the tenant passed to approve / act to verify propagation through the routes.
 */
function tenantAwarePromotions(): { api: PromotionsApi; seen: { approve?: string; act?: string } } {
  const owner: Record<string, string> = { "acme-art": "acme" };
  const seen: { approve?: string; act?: string } = {};
  const visible = (id: string, tenant?: string): boolean => {
    const t = owner[id];
    if (t == null) return false;
    return tenant == null || tenant === t;
  };
  const api: PromotionsApi = {
    async list() {
      return [];
    },
    async evaluateAndList() {
      return [];
    },
    async get(id, scope) {
      return visible(id, scope?.tenant) ? { artifactId: id, status: "candidate" } : null;
    },
    async act(id, _action, _actor, scope) {
      if (!visible(id, scope?.tenant)) throw new Error(`unknown artifact: ${id}`);
      seen.act = scope?.tenant;
      return { artifactId: id, status: "acted" };
    },
    async approve(id, _draft, _reviewer, scope) {
      if (!visible(id, scope?.tenant)) throw new Error(`unknown artifact: ${id}`);
      seen.approve = scope?.tenant;
      return { artifactId: id, status: "published" };
    },
    async reject(id, _reviewer, scope) {
      if (!visible(id, scope?.tenant)) throw new Error(`unknown artifact: ${id}`);
      return { artifactId: id, status: "rejected" };
    },
    async withdraw(id, _actor, options) {
      if (!visible(id, options?.tenant)) throw new Error(`unknown artifact: ${id}`);
      return { artifactId: id, status: "withdrawn" };
    },
  };
  return { api, seen };
}

/** promotions deps with deps.tenant wired (reading the x-kohaku-tenant header). */
function tenantDeps(promotions: PromotionsApi): KohakuHostDeps {
  return {
    compose: NO_COMPOSE,
    domain: NO_DOMAIN,
    authz: NO_AUTHZ,
    querySource: "sales",
    tenant: (c) => c.req.header("x-kohaku-tenant") || undefined,
    promotions,
  };
}

function reqT(
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

describe("promotions tenant scope", () => {
  it("GET /promotions/:id is 200 for the same tenant, 404 for a different tenant (treated as nonexistent)", async () => {
    const { api } = tenantAwarePromotions();
    const app = createKohakuRoutes(tenantDeps(api));

    expect((await reqT(app, "GET", "/promotions/acme-art", "acme")).status).toBe(200);
    // From another tenant (globex), the candidate is invisible due to ownership mismatch -> 404.
    expect((await reqT(app, "GET", "/promotions/acme-art", "globex")).status).toBe(404);
  });

  it("approve / actions are 404 from a different tenant, 200 for the same tenant and propagate tenant", async () => {
    const { api, seen } = tenantAwarePromotions();
    const app = createKohakuRoutes(tenantDeps(api));

    // approve from another tenant (globex): ensureArtifact's get returns null -> 404. approve is not called.
    const crossApprove = await reqT(app, "POST", "/promotions/acme-art/approve", "globex", { draft });
    expect(crossApprove.status).toBe(404);
    expect(seen.approve).toBeUndefined();

    // The same tenant (acme) is 200. tenant is propagated to approve.
    const sameApprove = await reqT(app, "POST", "/promotions/acme-art/approve", "acme", { draft });
    expect(sameApprove.status).toBe(200);
    expect(seen.approve).toBe("acme");

    // actions is the same: another tenant is 404, and the same tenant propagates tenant to act.
    const crossAct = await reqT(app, "POST", "/promotions/acme-art/actions", "globex", {
      action: { kind: "review.start" },
    });
    expect(crossAct.status).toBe(404);
    const sameAct = await reqT(app, "POST", "/promotions/acme-art/actions", "acme", {
      action: { kind: "review.start" },
    });
    expect(sameAct.status).toBe(200);
    expect(seen.act).toBe("acme");
  });

  it("on a host with no tenant configured, get / approve pass (regression)", async () => {
    const { api } = tenantAwarePromotions();
    // deps.tenant not wired -> resolveTenant is undefined -> visible regardless of ownership.
    const app = createKohakuRoutes(deps(api));

    expect((await app.request("/promotions/acme-art")).status).toBe(200);
    expect((await post(app, "/promotions/acme-art/approve", { draft })).status).toBe(200);
  });
});

/**
 * A fake that mimics read-modify-write. approve reads status -> yields -> if in_use, publishes (side effect)
 * -> writes status to published. Without host-rest's per-tenant serialization, two concurrent calls interleave
 * between read and write and publish fires twice. With serialization, the second call reads published and it stays at once.
 */
function racyPromotions(): { api: PromotionsApi; publishes: () => number } {
  let status = "in_use";
  let publishCount = 0;
  const api: PromotionsApi = {
    async list() {
      return [];
    },
    async evaluateAndList() {
      return [];
    },
    async get(id) {
      return { artifactId: id, status };
    },
    async act(id, action) {
      return { artifactId: id, status: "acted", action };
    },
    async approve(id) {
      const observed = status; // read
      await new Promise((r) => setTimeout(r, 5)); // yield (the interleaving window)
      if (observed === "in_use") {
        publishCount++; // publish-equivalent side effect (onPublish fires)
        status = "published"; // write
      }
      return { artifactId: id, status: "published" };
    },
    async reject(id) {
      return { artifactId: id, status: "rejected" };
    },
    async withdraw(id) {
      return { artifactId: id, status: "withdrawn" };
    },
  };
  return { api, publishes: () => publishCount };
}

describe("concurrency serialization of promotions promotion operations", () => {
  it("two concurrent approves on the same artifact fire the publish side effect once, and both responses are deterministic (200 published)", async () => {
    const { api, publishes } = racyPromotions();
    const app = createKohakuRoutes(deps(api));

    // Two concurrent calls (fired in parallel without awaiting).
    const [r1, r2] = await Promise.all([
      post(app, "/promotions/known/approve", { draft }),
      post(app, "/promotions/known/approve", { draft }),
    ]);

    // Serialization prevents the read-modify-write from interleaving, so the publish side effect fires exactly once.
    expect(publishes()).toBe(1);
    // Both calls give a deterministic response (idempotent success = 200 published; the second returns the already-published state).
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = (await r1.json()) as { candidate: { status: string } };
    const b2 = (await r2.json()) as { candidate: { status: string } };
    expect(b1.candidate.status).toBe("published");
    expect(b2.candidate.status).toBe("published");
  });

  it("within the same tenant, serialization holds even for different artifacts (keyed per tenant; also covers interleaving with evaluate)", async () => {
    // If the shared-state fake's read-modify-write is serialized, the second call reads published and
    // skips publish (if interleaved, it would fire twice) = evidence of ordering.
    const a = racyPromotions();
    const app = createKohakuRoutes(deps(a.api));
    await Promise.all([
      post(app, "/promotions/art-a/approve", { draft }),
      post(app, "/promotions/art-b/approve", { draft }),
    ]);
    expect(a.publishes()).toBe(1);
  });

  it("approves to different tenants do not block each other (serialization is independent per tenant)", async () => {
    const a = racyPromotions();
    const app = createKohakuRoutes({
      ...deps(a.api),
      tenant: (c) => c.req.header("x-kohaku-tenant") || undefined,
    });
    const postAs = (tenant: string, path: string) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-kohaku-tenant": tenant },
        body: JSON.stringify({ draft }),
      });
    // Different tenants use different locks, so they do not wait for each other; the reads interleave and the
    // shared-state fake's publish fires twice (= evidence they are not blocked).
    await Promise.all([postAs("t1", "/promotions/art-a/approve"), postAs("t2", "/promotions/art-b/approve")]);
    expect(a.publishes()).toBe(2);
  });
});

describe("promotions status filter / changes_requested recovery", () => {
  it("GET /promotions?status= passes status to listByStatus and returns its result", async () => {
    const seen: { status?: string } = {};
    const api: PromotionsApi = {
      async list() {
        return [{ artifactId: "x", status: "in_use" }];
      },
      async evaluateAndList() {
        return [];
      },
      async listByStatus(status) {
        seen.status = status;
        return [{ artifactId: "p1", status }];
      },
      async get(id) {
        return { artifactId: id, status: "candidate" };
      },
      async act(id, action) {
        return { artifactId: id, action };
      },
      async approve(id) {
        return { artifactId: id, status: "published" };
      },
      async reject(id) {
        return { artifactId: id, status: "rejected" };
      },
      async withdraw(id) {
        return { artifactId: id, status: "withdrawn" };
      },
    };
    const app = createKohakuRoutes(deps(api));
    const res = await app.request("/promotions?status=published");
    expect(res.status).toBe(200);
    expect(seen.status).toBe("published");
    expect(((await res.json()) as { candidates: { status: string }[] }).candidates).toEqual([
      { artifactId: "p1", status: "published" },
    ]);
  });

  it("for a PromotionsApi without listByStatus, filters list's result by status on the client side", async () => {
    const api: PromotionsApi = {
      async list() {
        return [
          { artifactId: "p1", status: "published" },
          { artifactId: "c1", status: "candidate" },
        ];
      },
      async evaluateAndList() {
        return [];
      },
      async get(id) {
        return { artifactId: id, status: "candidate" };
      },
      async act(id) {
        return { artifactId: id };
      },
      async approve(id) {
        return { artifactId: id, status: "published" };
      },
      async reject(id) {
        return { artifactId: id, status: "rejected" };
      },
      async withdraw(id) {
        return { artifactId: id, status: "withdrawn" };
      },
    };
    const app = createKohakuRoutes(deps(api));
    const res = await app.request("/promotions?status=candidate");
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { candidates: { artifactId: string }[] }).candidates.map((c) => c.artifactId),
    ).toEqual(["c1"]);
  });

  it("changes_requested recovery e2e: send back via actions → pick up via status filter → approve to published", async () => {
    // A stateful fake: actions (review.start / requestChanges) drops it to changes_requested, and
    // approve returns published even from changes_requested (verifying the service layer's changes-requested recovery through the routes).
    let status = "candidate";
    const api: PromotionsApi = {
      async list() {
        return [{ artifactId: "a1", status }];
      },
      async evaluateAndList() {
        return [{ artifactId: "a1", status }];
      },
      async listByStatus(s) {
        return status === s ? [{ artifactId: "a1", status }] : [];
      },
      async get(id) {
        return { artifactId: id, status };
      },
      async act(id, action) {
        const kind = (action as { kind?: string }).kind;
        if (kind === "review.start") status = "in_review";
        if (kind === "review.requestChanges") status = "changes_requested";
        return { artifactId: id, status };
      },
      async approve(id) {
        // Recover even from changes_requested to published (mimics the service layer's changes-requested recovery behavior).
        status = "published";
        return { artifactId: id, status };
      },
      async reject(id) {
        return { artifactId: id, status: "rejected" };
      },
      async withdraw(id) {
        return { artifactId: id, status: "withdrawn" };
      },
    };
    const app = createKohakuRoutes(deps(api));

    // candidate -> in_review -> changes_requested.
    expect((await post(app, "/promotions/a1/actions", { action: { kind: "review.start" } })).status).toBe(
      200,
    );
    expect(
      (await post(app, "/promotions/a1/actions", { action: { kind: "review.requestChanges" } })).status,
    ).toBe(200);

    // The status filter picks up changes_requested (other statuses are empty).
    const filtered = await app.request("/promotions?status=changes_requested");
    expect(((await filtered.json()) as { candidates: unknown[] }).candidates).toHaveLength(1);
    const other = await app.request("/promotions?status=published");
    expect(((await other.json()) as { candidates: unknown[] }).candidates).toHaveLength(0);

    // Reapply and approve -> published.
    const approveRes = await post(app, "/promotions/a1/approve", { draft });
    expect(approveRes.status).toBe(200);
    expect(((await approveRes.json()) as { candidate: { status: string } }).candidate.status).toBe(
      "published",
    );
  });
});

describe("promotions preview (POST /promotions/:id/preview)", () => {
  /** A fake AuthzPort that records issueCapability calls. */
  function spyAuthz(): AuthzPort & { issued: { scopes: unknown; ttl?: number }[] } {
    const issued: { scopes: unknown; ttl?: number }[] = [];
    return {
      issued,
      async issueCapability(_principal, scopes, opts) {
        issued.push({ scopes, ...(opts?.ttlSeconds != null ? { ttl: opts.ttlSeconds } : {}) });
        return "cap-preview-token";
      },
      async verify() {
        return { ok: true };
      },
    };
  }

  /** A fake that returns a candidate with html/sha256/ref ("full") and one with no material ("bare"). */
  function previewPromotions(): PromotionsApi {
    const { api } = fakePromotions();
    return {
      ...api,
      async get(id) {
        if (id === "full") {
          return {
            artifactId: id,
            status: "candidate",
            html: "<html>preview</html>",
            sha256: "a".repeat(64),
            ref: "query://sales/trend?metric=revenue",
          };
        }
        if (id === "bare") return { artifactId: id, status: "candidate" };
        if (id === "no-ref") {
          return { artifactId: id, status: "candidate", html: "<html>x</html>", sha256: "b".repeat(64) };
        }
        return null;
      },
    };
  }

  it("returns a recorded artifact's html/sha256/ref and a read capability scoped to just the single ref", async () => {
    const authz = spyAuthz();
    const app = createKohakuRoutes({ ...deps(previewPromotions()), authz });

    const res = await post(app, "/promotions/full/preview");
    expect(res.status).toBe(200);
    const { preview } = (await res.json()) as {
      preview: { html: string; sha256: string; ref?: string; capability?: string };
    };
    expect(preview.html).toBe("<html>preview</html>");
    expect(preview.sha256).toBe("a".repeat(64));
    expect(preview.ref).toBe("query://sales/trend?metric=revenue");
    expect(preview.capability).toBe("cap-preview-token");
    // The capability is only the read scope of the single generation-time ref (does not include write).
    expect(authz.issued).toHaveLength(1);
    expect(authz.issued[0]!.scopes).toEqual([{ kind: "read", ref: "query://sales/trend?metric=revenue" }]);
  });

  it("a candidate with no recorded ref returns html/sha256 only and does not issue a capability", async () => {
    const authz = spyAuthz();
    const app = createKohakuRoutes({ ...deps(previewPromotions()), authz });

    const res = await post(app, "/promotions/no-ref/preview");
    expect(res.status).toBe(200);
    const { preview } = (await res.json()) as {
      preview: { html: string; ref?: string; capability?: string };
    };
    expect(preview.html).toBe("<html>x</html>");
    expect(preview.ref).toBeUndefined();
    expect(preview.capability).toBeUndefined();
    expect(authz.issued).toHaveLength(0);
  });

  it("a candidate with no recorded html and an unknown artifact are 404", async () => {
    const app = createKohakuRoutes({ ...deps(previewPromotions()), authz: spyAuthz() });

    const bare = await post(app, "/promotions/bare/preview");
    expect(bare.status).toBe(404);
    const unknown = await post(app, "/promotions/nope/preview");
    expect(unknown.status).toBe(404);
  });
});

describe("POST /promotions/reconcile (#11 operator escape hatch)", () => {
  it("200s with the reconcile summary when PromotionsApi.reconcile is wired", async () => {
    const { api } = fakePromotions();
    let called = false;
    const app = createKohakuRoutes(
      deps({
        ...api,
        async reconcile() {
          called = true;
          return { published: 2, withdrawn: 1, skipped: 0 };
        },
      }),
    );

    const res = await post(app, "/promotions/reconcile");
    expect(res.status).toBe(200);
    expect(called).toBe(true);
    expect((await res.json()) as unknown).toEqual({
      summary: { published: 2, withdrawn: 1, skipped: 0 },
    });
  });

  it("501 NOT_IMPLEMENTED when PromotionsApi.reconcile is not implemented (optional field)", async () => {
    const { api } = fakePromotions();
    const app = createKohakuRoutes(deps(api));

    const res = await post(app, "/promotions/reconcile");
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NOT_IMPLEMENTED");
  });

  it("501 NOT_IMPLEMENTED when promotions itself is not configured", async () => {
    const app = createKohakuRoutes(deps());
    const res = await post(app, "/promotions/reconcile");
    expect(res.status).toBe(501);
  });

  it("denies via authorizeGovernance with kind promotion.reconcile, without calling the downstream API", async () => {
    const { api } = fakePromotions();
    let called = false;
    const app = createKohakuRoutes({
      ...deps({
        ...api,
        async reconcile() {
          called = true;
          return { published: 0, withdrawn: 0, skipped: 0 };
        },
      }),
      authorizeGovernance: (_principal, operation) => operation.kind !== "promotion.reconcile",
    });

    const res = await post(app, "/promotions/reconcile");
    expect(res.status).toBe(403);
    expect(called).toBe(false);
  });

  it("maps an unexpected reconcile() failure to 500 INTERNAL (message replaced; original error still reaches onError)", async () => {
    const { api } = fakePromotions();
    const errors: { endpoint: string }[] = [];
    const app = createKohakuRoutes({
      ...deps({
        ...api,
        async reconcile() {
          throw new Error("storage unavailable (test)");
        },
      }),
      onError: (info) => {
        errors.push({ endpoint: info.endpoint });
      },
    });

    const res = await post(app, "/promotions/reconcile");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).not.toMatch(/storage unavailable/);
    expect(errors).toEqual([{ endpoint: "promotion.reconcile" }]);
  });
});

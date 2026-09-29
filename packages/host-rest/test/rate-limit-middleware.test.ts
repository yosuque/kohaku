import type { ComposeContext } from "@kohaku-ui/composer";
import type { PolicyRateLimiter, PolicyRateLimiterTakeParams } from "@kohaku-ui/host-core";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type {
  AuthzPort,
  DomainPort,
  JsonObject,
  RateLimitResult,
  SemanticPort,
  UISpec,
} from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps } from "../src/index.js";

const catalog = resolveCatalog(coreCatalog);
const REF = "query://sales/summary?fy=2026&groupBy=region";

function stubSemantic(): SemanticPort {
  return {
    async normalize(input) {
      const params = input.kind === "nl" ? {} : { ...(input.current?.params ?? {}), ...input.params };
      return { canonical: "sales.trend", params, hash: "" };
    },
    async resolveQuery() {
      return { uri: REF };
    },
    async dataVersion() {
      return "sales@v1";
    },
  };
}

function fallbackFixed(): UISpec {
  return {
    kohaku: "0.1",
    intent: { canonical: "sales.trend", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "ignored",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["md1"] },
      { id: "md1", type: "presentMarkdown", props: { markdown: "fallback" } },
    ],
    events: [],
    provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
  };
}

function composeCtx(): ComposeContext {
  return {
    catalog,
    semantic: stubSemantic(),
    storage: {
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
    },
    llm: new FakeLlm(),
    policy: { fixedSpecs: { lookup: async () => fallbackFixed() } },
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

function echoDomain(): DomainPort {
  return {
    async listOperations() {
      return [];
    },
    async invoke(op: string, args: JsonObject) {
      return { ok: true, op, args };
    },
  };
}

/** A rate limiter stub whose take() always returns `result` and records every call. */
function stubRateLimiter(result: RateLimitResult): {
  limiter: PolicyRateLimiter;
  calls: PolicyRateLimiterTakeParams[];
} {
  const calls: PolicyRateLimiterTakeParams[] = [];
  return {
    calls,
    limiter: {
      async take(params) {
        calls.push(params);
        return result;
      },
    },
  };
}

function baseDeps(extra?: Partial<KohakuHostDeps>): KohakuHostDeps {
  return {
    compose: composeCtx(),
    domain: echoDomain(),
    authz: allowAuthz(),
    querySource: "sales",
    ...extra,
  };
}

describe("rate-limit middleware: backward compatibility", () => {
  it("does not affect /compose when deps.rateLimiter is unset", async () => {
    const app = createKohakuRoutes(baseDeps());
    const res = await app.request("/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.trend", params: {} } }),
    });
    expect(res.status).toBe(200);
  });
});

describe("rate-limit middleware: denial", () => {
  it("returns 429 RATE_LIMITED with Retry-After for /compose", async () => {
    const { limiter } = stubRateLimiter({ allow: false, retryAfterMs: 2500 });
    const app = createKohakuRoutes(baseDeps({ rateLimiter: limiter }));
    const res = await app.request("/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.trend", params: {} } }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3"); // ceil(2500/1000)
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "rate limit exceeded",
        requestId: res.headers.get("X-Request-Id"),
        retryAfterMs: 2500,
      },
    });
  });

  it("returns 429 without a Retry-After header when retryAfterMs is not given", async () => {
    const { limiter } = stubRateLimiter({ allow: false });
    const app = createKohakuRoutes(baseDeps({ rateLimiter: limiter }));
    const res = await app.request("/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.trend", params: {} } }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  it("denies POST /binding/action with routeClass 'action'", async () => {
    const { limiter, calls } = stubRateLimiter({ allow: false, retryAfterMs: 1000 });
    const app = createKohakuRoutes(baseDeps({ rateLimiter: limiter }));
    const res = await app.request("/binding/action", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer cap" },
      body: JSON.stringify({ action: "annotate", payload: {} }),
    });
    expect(res.status).toBe(429);
    expect(calls[0]?.routeClass).toBe("action");
  });

  it("denies GET /binding/resolve with routeClass 'resolve'", async () => {
    const { limiter, calls } = stubRateLimiter({ allow: false, retryAfterMs: 1000 });
    const app = createKohakuRoutes(baseDeps({ rateLimiter: limiter }));
    const res = await app.request(`/binding/resolve?ref=${encodeURIComponent(REF)}`, {
      headers: { authorization: "Bearer cap" },
    });
    expect(res.status).toBe(429);
    expect(calls[0]?.routeClass).toBe("resolve");
  });

  it("denies POST /intent/normalize under the 'compose' route class (it calls the SemanticPort's LLM)", async () => {
    const { limiter, calls } = stubRateLimiter({ allow: false, retryAfterMs: 1000 });
    const app = createKohakuRoutes(baseDeps({ rateLimiter: limiter }));
    const res = await app.request("/intent/normalize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { kind: "nl", text: "revenue by month" } }),
    });
    expect(res.status).toBe(429);
    expect(calls[0]?.routeClass).toBe("compose");
  });

  it("does not apply to governance routes (GET /lineage) even when the limiter always denies", async () => {
    const { limiter } = stubRateLimiter({ allow: false, retryAfterMs: 1000 });
    const app = createKohakuRoutes(baseDeps({ rateLimiter: limiter }));
    const res = await app.request("/lineage");
    expect(res.status).not.toBe(429);
  });
});

describe("rate-limit middleware: observability", () => {
  const composeRequest = {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "req-rl-1" },
    body: JSON.stringify({ intent: { canonical: "sales.trend", params: {} } }),
  };

  it("carries the request id in the 429 envelope and notifies onRateLimited with it", async () => {
    const { limiter } = stubRateLimiter({ allow: false, retryAfterMs: 1000 });
    const seen: unknown[] = [];
    const app = createKohakuRoutes(
      baseDeps({
        rateLimiter: limiter,
        tenant: () => "tenant-a",
        auth: async () => ({ id: "alice", roles: ["user"] }),
        onRateLimited: (info) => void seen.push(info),
      }),
    );
    const res = await app.request("/compose", composeRequest);
    expect(res.status).toBe(429);
    expect(res.headers.get("X-Request-Id")).toBe("req-rl-1");
    expect(((await res.json()) as { error: { requestId?: string } }).error.requestId).toBe("req-rl-1");
    expect(seen).toEqual([
      { tenant: "tenant-a", principal: "alice", routeClass: "compose", requestId: "req-rl-1" },
    ]);
  });

  it("does not call onRateLimited for an allowed request", async () => {
    const { limiter } = stubRateLimiter({ allow: true });
    const seen: unknown[] = [];
    const app = createKohakuRoutes(
      baseDeps({ rateLimiter: limiter, onRateLimited: (i) => void seen.push(i) }),
    );
    expect((await app.request("/compose", composeRequest)).status).toBe(200);
    expect(seen).toEqual([]);
  });

  it("never awaits onRateLimited: a hung or throwing observer cannot delay or break the 429", async () => {
    const { limiter } = stubRateLimiter({ allow: false });
    const hung = createKohakuRoutes(
      baseDeps({ rateLimiter: limiter, onRateLimited: () => new Promise<void>(() => {}) }),
    );
    expect((await hung.request("/compose", composeRequest)).status).toBe(429);
    const throwing = createKohakuRoutes(
      baseDeps({
        rateLimiter: limiter,
        onRateLimited: () => {
          throw new Error("observer down");
        },
      }),
    );
    expect((await throwing.request("/compose", composeRequest)).status).toBe(429);
  });
});

describe("rate-limit middleware: allow", () => {
  it("lets the request through and the handler still runs", async () => {
    const { limiter } = stubRateLimiter({ allow: true });
    const app = createKohakuRoutes(baseDeps({ rateLimiter: limiter }));
    const res = await app.request("/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.trend", params: {} } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spec: UISpec };
    expect(body.spec.provenance.tier).toBe("L0");
  });
});

describe("rate-limit middleware: routing key", () => {
  it("passes tenant and principal.id through to rateLimiter.take", async () => {
    const { limiter, calls } = stubRateLimiter({ allow: true });
    const app = createKohakuRoutes(
      baseDeps({
        rateLimiter: limiter,
        tenant: () => "tenant-a",
        auth: async () => ({ id: "alice", roles: ["user"] }),
      }),
    );
    await app.request("/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.trend", params: {} } }),
    });
    expect(calls[0]).toMatchObject({ tenant: "tenant-a", principal: "alice", routeClass: "compose" });
  });
});

import type { ComposeContext } from "@kohaku-ui/composer";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type {
  AuthzPort,
  DomainPort,
  FixationRecord,
  SemanticPort,
  StoragePort,
  UISpec,
} from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps } from "../src/index.js";

// Correlation-id propagation (ops): the inbound `x-request-id` request header (when present and well-formed)
// is echoed as the `X-Request-Id` response header on every response and reused for `error.requestId`; a
// missing or malformed header falls back to a freshly minted id. See routes/shared.ts's requestIdOf.

const catalog = resolveCatalog(coreCatalog);
const REF = "query://sales/summary?fy=2026&groupBy=region";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function okSemantic(): SemanticPort {
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

function failingSemantic(): SemanticPort {
  return {
    async normalize(input) {
      const params = input.kind === "nl" ? {} : { ...(input.current?.params ?? {}), ...input.params };
      return { canonical: "sales.trend", params, hash: "" };
    },
    async resolveQuery() {
      throw new Error("reference resolution failed (test)");
    },
    async dataVersion() {
      return "sales@v1";
    },
  };
}

function stubStorage(): StoragePort {
  const cache = new Map<string, UISpec>();
  return {
    async getSpecCache(k) {
      return cache.get(k) ?? null;
    },
    async putSpecCache(k, s) {
      cache.set(k, s);
    },
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

function composeCtx(semantic: SemanticPort): ComposeContext {
  return { catalog, semantic, storage: stubStorage(), llm: new FakeLlm(), policy: {} };
}

function baseDeps(semantic: SemanticPort): KohakuHostDeps {
  return {
    compose: composeCtx(semantic),
    domain,
    authz: allowAuthz(),
    querySource: "sales",
  };
}

function composeReq(headers?: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify({ intent: { canonical: "sales.trend", params: {} } }),
  };
}

describe("request id propagation (host-rest, ops)", () => {
  it("echoes the inbound x-request-id header as X-Request-Id on a successful response", async () => {
    const app = createKohakuRoutes(baseDeps(okSemantic()));
    const res = await app.request("/catalog", { headers: { "x-request-id": "caller-supplied-id-123" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe("caller-supplied-id-123");
  });

  it("echoes the inbound x-request-id header on an error response and reuses it for error.requestId", async () => {
    const app = createKohakuRoutes(baseDeps(failingSemantic()));
    const res = await app.request("/compose", composeReq({ "x-request-id": "trace-abc-999" }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { requestId?: string } };
    expect(res.headers.get("X-Request-Id")).toBe("trace-abc-999");
    expect(body.error.requestId).toBe("trace-abc-999");
  });

  it("generates a UUID when no x-request-id header is present", async () => {
    const app = createKohakuRoutes(baseDeps(okSemantic()));
    const res = await app.request("/catalog");
    expect(res.status).toBe(200);
    const id = res.headers.get("X-Request-Id");
    expect(id).not.toBeNull();
    expect(id).toMatch(UUID_RE);
  });

  it("replaces an oversized x-request-id header with a generated id", async () => {
    const app = createKohakuRoutes(baseDeps(okSemantic()));
    const res = await app.request("/catalog", { headers: { "x-request-id": "x".repeat(200) } });
    expect(res.status).toBe(200);
    const id = res.headers.get("X-Request-Id");
    expect(id).toMatch(UUID_RE);
  });

  it("replaces a whitespace-only x-request-id header with a generated id", async () => {
    const app = createKohakuRoutes(baseDeps(okSemantic()));
    const res = await app.request("/catalog", { headers: { "x-request-id": "   " } });
    expect(res.status).toBe(200);
    const id = res.headers.get("X-Request-Id");
    expect(id).toMatch(UUID_RE);
  });

  it("resolves the same request id for every response of the same request (memoized per Request)", async () => {
    const seen: string[] = [];
    const deps: KohakuHostDeps = {
      ...baseDeps(failingSemantic()),
      onError: (info) => {
        seen.push(info.requestId);
      },
    };
    const app = createKohakuRoutes(deps);
    const res = await app.request("/compose", composeReq({ "x-request-id": "one-id-for-everything" }));
    const body = (await res.json()) as { error: { requestId?: string } };
    expect(res.headers.get("X-Request-Id")).toBe("one-id-for-everything");
    expect(body.error.requestId).toBe("one-id-for-everything");
    expect(seen).toEqual(["one-id-for-everything"]);
  });

  it("a product-supplied deps.requestId overrides the default header/UUID resolution", async () => {
    const deps: KohakuHostDeps = {
      ...baseDeps(okSemantic()),
      requestId: () => "fixed-product-id",
    };
    const app = createKohakuRoutes(deps);
    const res = await app.request("/catalog", { headers: { "x-request-id": "should-be-ignored" } });
    expect(res.headers.get("X-Request-Id")).toBe("fixed-product-id");
  });

  it("threads the request id into ComposeOptions.correlationId, visible on the delivered ComposeTrace", async () => {
    let correlationId: string | undefined;
    const compose: ComposeContext = {
      ...composeCtx(okSemantic()),
      observer: {
        onComposed: (trace) => {
          correlationId = trace.correlationId;
        },
      },
    };
    const deps: KohakuHostDeps = { ...baseDeps(okSemantic()), compose };
    const app = createKohakuRoutes(deps);
    const res = await app.request("/compose", composeReq({ "x-request-id": "compose-trace-corr-1" }));
    expect(res.status).toBe(200);
    expect(correlationId).toBe("compose-trace-corr-1");
  });

  it("threads the `traceparent` request header into ComposeOptions.traceContext, visible on the delivered ComposeTrace", async () => {
    let traceContext: { traceparent: string; tracestate?: string } | undefined;
    const compose: ComposeContext = {
      ...composeCtx(okSemantic()),
      observer: {
        onComposed: (trace) => {
          traceContext = trace.traceContext;
        },
      },
    };
    const deps: KohakuHostDeps = { ...baseDeps(okSemantic()), compose };
    const app = createKohakuRoutes(deps);
    const res = await app.request(
      "/compose",
      composeReq({ traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" }),
    );
    expect(res.status).toBe(200);
    expect(traceContext).toEqual({ traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" });
  });

  it("leaves ComposeOptions.traceContext unset for a missing or malformed `traceparent` header (fail-open)", async () => {
    let traceContext: { traceparent: string; tracestate?: string } | undefined = { traceparent: "sentinel" };
    const compose: ComposeContext = {
      ...composeCtx(okSemantic()),
      observer: {
        onComposed: (trace) => {
          traceContext = trace.traceContext;
        },
      },
    };
    const deps: KohakuHostDeps = { ...baseDeps(okSemantic()), compose };
    const app = createKohakuRoutes(deps);
    const res = await app.request("/compose", composeReq({ traceparent: "not-a-w3c-traceparent" }));
    expect(res.status).toBe(200);
    expect(traceContext).toBeUndefined();
  });

  it("threads the `tracestate` request header alongside `traceparent` into ComposeOptions.traceContext", async () => {
    let traceContext: { traceparent: string; tracestate?: string } | undefined;
    const compose: ComposeContext = {
      ...composeCtx(okSemantic()),
      observer: {
        onComposed: (trace) => {
          traceContext = trace.traceContext;
        },
      },
    };
    const deps: KohakuHostDeps = { ...baseDeps(okSemantic()), compose };
    const app = createKohakuRoutes(deps);
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const res = await app.request("/compose", composeReq({ traceparent, tracestate: "vendor=value" }));
    expect(res.status).toBe(200);
    expect(traceContext).toEqual({ traceparent, tracestate: "vendor=value" });
  });

  it("threads the `traceparent` request header into ComposeOptions.traceContext on POST /compose/stream too (a separate wiring site)", async () => {
    let traceContext: { traceparent: string; tracestate?: string } | undefined;
    const compose: ComposeContext = {
      ...composeCtx(okSemantic()),
      observer: {
        onComposed: (trace) => {
          traceContext = trace.traceContext;
        },
      },
    };
    const deps: KohakuHostDeps = { ...baseDeps(okSemantic()), compose };
    const app = createKohakuRoutes(deps);
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const res = await app.request("/compose/stream", composeReq({ traceparent }));
    expect(res.status).toBe(200);
    // Drains the SSE body to completion so the compose (and onComposed) actually runs.
    await res.text();
    expect(traceContext).toEqual({ traceparent });
  });

  it("threads traceContext through the fixation self-heal path (stale fixation -> normal-compose fallback), visible on the delivered ComposeTrace", async () => {
    let traceContext: { traceparent: string; tracestate?: string } | undefined;
    const compose: ComposeContext = {
      ...composeCtx(okSemantic()),
      observer: {
        onComposed: (trace) => {
          traceContext = trace.traceContext;
        },
      },
    };
    // A fixed Spec whose refVersions drift from the current Intent's resolution result (REF), so
    // materializeFixation judges it stale and composeWithFixation falls through to the normal-compose
    // fallback below (rather than short-circuiting delivery) — exercising the same traceContext-threading
    // this describe block already covers for the no-fixation-at-all path, but through the fixation branch
    // of composeWithFixation instead.
    const staleFixation: FixationRecord = {
      intentHash: "sha256:" + "a".repeat(64),
      canonical: "sales.trend",
      structureHash: "sha256:" + "b".repeat(64),
      pinnedSpec: {
        kohaku: "0.1",
        intent: { canonical: "sales.trend", params: {}, hash: "" },
        dataVersion: "x",
        components: [{ id: "root", type: "layout.stack", props: {}, children: [] }],
        events: [],
        refVersions: { "query://sales/other?x=1": "v1" },
        provenance: { tier: "L0", composedBy: "test", cache: "fixated" },
      } as UISpec,
      fixatedAt: "2026-07-01T00:00:00Z",
      approver: { id: "tester" },
      catalogFingerprint: "fp-judged",
    };
    const deps: KohakuHostDeps = {
      ...baseDeps(okSemantic()),
      compose,
      fixationLookup: async () => staleFixation,
      fixations: {
        async invalidate() {},
        async proposals() {
          return [];
        },
        async list() {
          return [];
        },
        async fixate() {
          return {};
        },
        async unfixate() {},
      },
    };
    const app = createKohakuRoutes(deps);
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const res = await app.request("/compose", composeReq({ traceparent }));
    expect(res.status).toBe(200);
    expect(traceContext).toEqual({ traceparent });
  });
});

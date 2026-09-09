import type { ComposeContext } from "@kohaku-ui/composer";
import {
  type GenerateObjectRequest,
  type GenerateObjectResult,
  LlmError,
  type LlmPort,
} from "@kohaku-ui/llm";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import {
  type AuthzPort,
  computeSpecHash,
  type DomainPort,
  type SemanticPort,
  type StoragePort,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps, type ViewRecorder } from "../src/index.js";

// host-rest wiring tests for failure-path observability and the streaming path's compute-specHash-once sharing.

const catalog = resolveCatalog(coreCatalog);
const REF = "query://sales/summary?fy=2026&groupBy=region";

/** A SemanticPort that throws on reference resolution (forces a hard compose failure -> COMPOSE_FAILED). */
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

/** A SemanticPort that resolves normally (used for streaming delivery of an L0 fixed Spec). */
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

/** An L0 fixed template with no data reference (no LLM needed; passes finishStream on the streaming path). */
function l0FixedSpec(): UISpec {
  return {
    kohaku: "0.1",
    intent: { canonical: "sales.trend", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "ignored",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["md1"] },
      { id: "md1", type: "presentMarkdown", props: { markdown: "Pinned view" } },
    ],
    events: [],
    provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
  };
}

function composeCtx(semantic: SemanticPort, policy: ComposeContext["policy"] = {}): ComposeContext {
  return { catalog, semantic, storage: stubStorage(), llm: new FakeLlm(), policy };
}

function composeReq(): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: { canonical: "sales.trend", params: {} } }),
  };
}

describe("observability of the failure path (host-rest)", () => {
  it("on compose failure, onError is called with a requestId that matches the response's error.requestId", async () => {
    const seen: { endpoint: string; requestId: string; error: unknown }[] = [];
    const deps: KohakuHostDeps = {
      compose: composeCtx(failingSemantic()),
      domain,
      authz: allowAuthz(),
      querySource: "sales",
      onError: (info) => {
        seen.push(info);
      },
    };
    const app = createKohakuRoutes(deps);

    const res = await app.request("/compose", composeReq());
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: { code: string; message: string; requestId?: string };
    };
    expect(body.error.code).toBe("COMPOSE_FAILED");
    expect(typeof body.error.requestId).toBe("string");
    expect(body.error.requestId!.length).toBeGreaterThan(0);

    // onError is called exactly once with the same requestId, endpoint, and the causing exception.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.endpoint).toBe("compose");
    expect(seen[0]!.requestId).toBe(body.error.requestId);
    expect(seen[0]!.error).toBeInstanceOf(Error);
  });

  it("even when onError is not wired, a requestId is still issued and placed on the error envelope and X-Request-Id header (ops)", async () => {
    const deps: KohakuHostDeps = {
      compose: composeCtx(failingSemantic()),
      domain,
      authz: allowAuthz(),
      querySource: "sales",
      // no onError
    };
    const app = createKohakuRoutes(deps);

    const res = await app.request("/compose", composeReq());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; requestId?: string } };
    expect(body.error.code).toBe("COMPOSE_FAILED");
    // requestId resolution is decoupled from onError being wired: every request gets one now.
    expect(typeof body.error.requestId).toBe("string");
    expect(body.error.requestId!.length).toBeGreaterThan(0);
    expect(res.headers.get("X-Request-Id")).toBe(body.error.requestId);
  });

  it("even when the onError hook throws, the error response is returned as usual (observation-only)", async () => {
    const deps: KohakuHostDeps = {
      compose: composeCtx(failingSemantic()),
      domain,
      authz: allowAuthz(),
      querySource: "sales",
      onError: () => {
        throw new Error("hook error");
      },
    };
    const app = createKohakuRoutes(deps);

    const res = await app.request("/compose", composeReq());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; requestId?: string } };
    expect(body.error.code).toBe("COMPOSE_FAILED");
    expect(typeof body.error.requestId).toBe("string");
  });
});

describe("sharing a single specHash computation on the stream path (host-rest)", () => {
  it("/compose/stream passes the specHash computed in finishStream to recorder.composed", async () => {
    const captured: { spec: UISpec; specHash?: string }[] = [];
    const recorder: ViewRecorder = {
      async composed(args) {
        captured.push({ spec: args.spec, specHash: args.specHash });
      },
      async interacted() {},
    };
    const deps: KohakuHostDeps = {
      compose: composeCtx(okSemantic(), { fixedSpecs: { lookup: async () => l0FixedSpec() } }),
      domain,
      authz: allowAuthz(),
      querySource: "sales",
      recorder,
    };
    const app = createKohakuRoutes(deps);

    const res = await app.request("/compose/stream", composeReq());
    expect(res.status).toBe(200);
    await res.text(); // Consume the SSE stream and advance to termination.

    // recorder.composed is called exactly once against the final Spec and receives the precomputed specHash.
    expect(captured).toHaveLength(1);
    // The passed specHash is the same value as the done event (= the Spec's actual hash). It is shared, not recomputed.
    expect(captured[0]!.specHash).toBe(await computeSpecHash(captured[0]!.spec));
  });
});

/** A recorder whose composed always throws (reproduces an audit-recording failure). */
function throwingRecorder(): ViewRecorder {
  return {
    async composed() {
      throw new Error("recorder recording failed (test)");
    },
    async interacted() {},
  };
}

describe("audit recording fail-open (host-rest)", () => {
  it("/compose returns 200 even when recorder.composed throws, and the error reaches the observability hook", async () => {
    const seen: { endpoint: string; error: unknown }[] = [];
    const deps: KohakuHostDeps = {
      compose: composeCtx(okSemantic(), { fixedSpecs: { lookup: async () => l0FixedSpec() } }),
      domain,
      authz: allowAuthz(),
      querySource: "sales",
      recorder: throwingRecorder(),
      onError: (info) => {
        seen.push({ endpoint: info.endpoint, error: info.error });
      },
    };
    const app = createKohakuRoutes(deps);

    const res = await app.request("/compose", composeReq());
    // Even if audit recording fails, delivery (the Spec) is still returned as success.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spec: UISpec };
    expect(body.spec).toBeDefined();
    // The failure is notified to the observability hook (endpoint = compose).
    expect(seen).toHaveLength(1);
    expect(seen[0]!.endpoint).toBe("compose");
    expect(seen[0]!.error).toBeInstanceOf(Error);
  });

  it("/compose/stream terminates normally with done even when recorder.composed throws, and reaches the observability hook", async () => {
    const seen: string[] = [];
    const deps: KohakuHostDeps = {
      compose: composeCtx(okSemantic(), { fixedSpecs: { lookup: async () => l0FixedSpec() } }),
      domain,
      authz: allowAuthz(),
      querySource: "sales",
      recorder: throwingRecorder(),
      onError: (info) => {
        seen.push(info.endpoint);
      },
    };
    const app = createKohakuRoutes(deps);

    const res = await app.request("/compose/stream", composeReq());
    expect(res.status).toBe(200);
    const text = await res.text();
    // Even if the recorder throws, the done event is emitted (it does not turn into an error event).
    expect(text).toContain("event: done");
    expect(text).not.toContain("event: error");
    expect(seen).toContain("compose/stream");
  });
});

/** An LlmPort that throws ABORTED when the request's abort signal is already firing, otherwise returns a
 * minimal valid L1 draft (so a non-aborted request in the same suite would still succeed). */
function abortAwareLlm(): LlmPort {
  return {
    provider: "abort-aware",
    modelId: "abort-model",
    async generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
      if (req.abort?.aborted === true) {
        throw new LlmError("ABORTED", "aborted(test)");
      }
      return {
        object: {
          components: [
            { id: "root", type: "layout.stack", props: {}, children: ["md1"] },
            { id: "md1", type: "presentMarkdown", props: { markdown: "hi" } },
          ],
          events: [],
        } as T,
        usage: { inputTokens: 0, outputTokens: 0 },
        model: "abort-model",
      };
    },
    async generateText() {
      throw new Error("abort-aware stub: generateText not supported");
    },
  };
}

describe("cancelled compose skips lineage recording (host-rest)", () => {
  it("a cancelled compose records neither view.composed nor view.fallback", async () => {
    const recorded: string[] = [];
    const recorder: ViewRecorder = {
      async composed() {
        recorded.push("composed");
      },
      async fallback() {
        recorded.push("fallback");
      },
      async interacted() {},
    };
    const deps: KohakuHostDeps = {
      compose: {
        catalog,
        semantic: okSemantic(),
        storage: stubStorage(),
        llm: abortAwareLlm(),
      },
      domain,
      authz: allowAuthz(),
      querySource: "sales",
      recorder,
    };
    const app = createKohakuRoutes(deps);

    const controller = new AbortController();
    controller.abort(); // request already abandoned before compose runs

    const res = await app.request("/compose", { ...composeReq(), signal: controller.signal });

    // A cancelled compose still delivers a (fallback) Spec normally, not an error response.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spec: UISpec };
    expect(body.spec.provenance.fallback).toBeDefined();

    // Neither view.composed nor view.fallback was recorded for the cancelled compose.
    expect(recorded).toEqual([]);
  });
});

import type { ComposeContext } from "@kohaku-ui/composer";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import {
  type AuthzPort,
  computeSpecHash,
  computeStructureHash,
  type DomainPort,
  type FixationRecord,
  finalizeIntent,
  type SemanticPort,
  type StoragePort,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps, type ViewRecorder } from "../src/index.js";

// Characterization of the compose delivery sequence (compose -> capability -> action manifest -> audit
// record) as the REST profile runs it today, pinned BEFORE the shared host-core helpers are extracted:
// - the exact onError calls (endpoint, order, which error) when several delivery steps fail in one request,
// - the exact recorder.composed / recorder.fallback argument shapes (key presence and key order).
// These tests describe what the code does, not what it should do.

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

const okDomain: DomainPort = {
  async listOperations() {
    return [];
  },
  async invoke() {
    return {};
  },
};

/** A domain whose listOperations always rejects (the operation index is retried and rejects every time). */
const failingDomain: DomainPort = {
  async listOperations() {
    throw new Error("list-ops down");
  },
  async invoke() {
    return {};
  },
};

/** An L0 fixed template with no data reference and no write actions. */
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

function fixedCtx(): ComposeContext {
  return {
    catalog,
    semantic: stubSemantic(),
    storage: stubStorage(),
    llm: new FakeLlm(),
    policy: { fixedSpecs: { lookup: async () => l0FixedSpec() } },
  };
}

/** A compose context whose L1 always fails validation, so every compose ends in a deterministic fallback. */
function fallbackCtx(): ComposeContext {
  return {
    catalog,
    semantic: stubSemantic(),
    storage: stubStorage(),
    llm: new FakeLlm({ objects: [{ components: [], events: [] }] }),
    policy: {},
  };
}

const REQUEST_INTENT = await finalizeIntent({ canonical: "sales.trend", params: {} });

async function pinnedFixation(): Promise<FixationRecord> {
  const pinnedSpec = l0FixedSpec();
  return {
    intentHash: REQUEST_INTENT.hash,
    canonical: "sales.trend",
    structureHash: await computeStructureHash(pinnedSpec),
    pinnedSpec,
    fixatedAt: "2026-06-10T00:00:00Z",
    approver: { id: "tester" },
    catalogFingerprint: catalog.fingerprint,
  };
}

function postJson(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

const INTENT_BODY = { intent: { canonical: "sales.trend", params: {} } };

type Seen = { endpoint: string; requestId: string; error: unknown };

function collectErrors(): { seen: Seen[]; onError: NonNullable<KohakuHostDeps["onError"]> } {
  const seen: Seen[] = [];
  return {
    seen,
    onError: (info) => {
      seen.push({ endpoint: info.endpoint, requestId: info.requestId, error: info.error });
    },
  };
}

function messages(seen: Seen[]): string[] {
  return seen.map((s) => (s.error as Error).message);
}

/**
 * createKohakuRoutes validates the operation index eagerly, so a rejecting listOperations produces one
 * "attach.operationIndex" report before any request. Pin it, then return only the per-request reports.
 */
function afterAttach(seen: Seen[]): Seen[] {
  expect(seen[0]!.endpoint).toBe("attach.operationIndex");
  expect((seen[0]!.error as Error).message).toBe("list-ops down");
  return seen.slice(1);
}

function throwingRecorder(): ViewRecorder {
  return {
    async composed() {
      throw new Error("record down");
    },
    async interacted() {},
  };
}

describe("delivery onError sequence on /compose (host-rest characterization)", () => {
  it("listOperations rejects AND recorder.composed throws: three reports in order capability -> record -> actions, response still 200 with the spec", async () => {
    const { seen, onError } = collectErrors();
    const app = createKohakuRoutes({
      compose: fixedCtx(),
      domain: failingDomain,
      authz: allowAuthz(),
      querySource: "sales",
      recorder: throwingRecorder(),
      onError,
    });
    const res = await app.request("/compose", postJson(INTENT_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spec?: UISpec; capability?: string; actions?: unknown };
    expect(body.spec).toBeDefined();
    expect(body.capability).toBe("cap");
    expect(body.actions).toBeUndefined();

    const delivery = afterAttach(seen);
    expect(delivery.map((s) => s.endpoint)).toEqual(["compose", "compose", "compose"]);
    expect(messages(delivery)).toEqual(["list-ops down", "record down", "list-ops down"]);
    // All reports carry the one request id (the response header).
    for (const s of delivery) expect(s.requestId).toBe(res.headers.get("X-Request-Id"));
  });

  it("authz.issueCapability rejects AND listOperations rejects AND recorder throws: capability failure is fail-closed (500 COMPOSE_FAILED), the recorder is never reached", async () => {
    const { seen, onError } = collectErrors();
    let recorderCalls = 0;
    const authz: AuthzPort = {
      async issueCapability() {
        throw new Error("issue down");
      },
      async verify() {
        return { ok: true, principal: { id: "u", roles: ["user"] } };
      },
    };
    const app = createKohakuRoutes({
      compose: fixedCtx(),
      domain: failingDomain,
      authz,
      querySource: "sales",
      recorder: {
        async composed() {
          recorderCalls++;
          throw new Error("record down");
        },
        async interacted() {},
      },
      onError,
    });
    const res = await app.request("/compose", postJson(INTENT_BODY));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("COMPOSE_FAILED");

    const delivery = afterAttach(seen);
    expect(delivery.map((s) => s.endpoint)).toEqual(["compose", "compose"]);
    expect(messages(delivery)).toEqual(["list-ops down", "issue down"]);
    expect(recorderCalls).toBe(0);
  });
});

describe("delivery onError sequence on /compose/stream (host-rest characterization)", () => {
  it("generated final spec: capability -> actions -> (write spec event) -> record, and done still arrives", async () => {
    const { seen, onError } = collectErrors();
    const app = createKohakuRoutes({
      compose: fixedCtx(),
      domain: failingDomain,
      authz: allowAuthz(),
      querySource: "sales",
      recorder: throwingRecorder(),
      onError,
    });
    const res = await app.request("/compose/stream", postJson(INTENT_BODY));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: spec");
    expect(text).toContain("event: done");
    expect(text).not.toContain("event: error");

    const delivery = afterAttach(seen);
    expect(delivery.map((s) => s.endpoint)).toEqual(["compose/stream", "compose/stream", "compose/stream"]);
    expect(messages(delivery)).toEqual(["list-ops down", "list-ops down", "record down"]);
  });

  it("fixated spec: the same capability -> actions -> record order, and done still arrives", async () => {
    const { seen, onError } = collectErrors();
    const fixation = await pinnedFixation();
    const app = createKohakuRoutes({
      compose: fixedCtx(),
      domain: failingDomain,
      authz: allowAuthz(),
      querySource: "sales",
      recorder: throwingRecorder(),
      fixationLookup: async () => fixation,
      onError,
    });
    const res = await app.request("/compose/stream", postJson(INTENT_BODY));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"cache":"fixated"');
    expect(text).toContain("event: done");
    expect(text).not.toContain("event: error");

    const delivery = afterAttach(seen);
    expect(delivery.map((s) => s.endpoint)).toEqual(["compose/stream", "compose/stream", "compose/stream"]);
    expect(messages(delivery)).toEqual(["list-ops down", "list-ops down", "record down"]);
  });

  it("authz.issueCapability rejects: the error ends the stream with an error event (no done), reported once after the index failure", async () => {
    const { seen, onError } = collectErrors();
    let recorderCalls = 0;
    const authz: AuthzPort = {
      async issueCapability() {
        throw new Error("issue down");
      },
      async verify() {
        return { ok: true, principal: { id: "u", roles: ["user"] } };
      },
    };
    const app = createKohakuRoutes({
      compose: fixedCtx(),
      domain: failingDomain,
      authz,
      querySource: "sales",
      recorder: {
        async composed() {
          recorderCalls++;
        },
        async interacted() {},
      },
      onError,
    });
    const res = await app.request("/compose/stream", postJson(INTENT_BODY));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).not.toContain("event: done");

    const delivery = afterAttach(seen);
    expect(delivery.map((s) => s.endpoint)).toEqual(["compose/stream", "compose/stream"]);
    expect(messages(delivery)).toEqual(["list-ops down", "issue down"]);
    expect(recorderCalls).toBe(0);
  });
});

describe("recorder argument shapes (host-rest characterization)", () => {
  function capturing(): {
    recorder: ViewRecorder;
    composed: Record<string, unknown>[];
    fallback: Record<string, unknown>[];
  } {
    const composed: Record<string, unknown>[] = [];
    const fallback: Record<string, unknown>[] = [];
    return {
      composed,
      fallback,
      recorder: {
        async composed(args) {
          composed.push(args as unknown as Record<string, unknown>);
        },
        async fallback(args) {
          fallback.push(args as unknown as Record<string, unknown>);
        },
        async interacted() {},
      },
    };
  }

  function deps(recorder: ViewRecorder, extra?: Partial<KohakuHostDeps>): KohakuHostDeps {
    return {
      compose: fallbackCtx(),
      domain: okDomain,
      authz: allowAuthz(),
      querySource: "sales",
      recorder,
      tenant: (c) => c.req.header("x-kohaku-tenant") || undefined,
      ...extra,
    };
  }

  it("/compose with a session id and a tenant: composed + fallback carry specHash, sessionId, tenant (and correlationId on fallback), in this key order", async () => {
    const cap = capturing();
    const app = createKohakuRoutes(deps(cap.recorder));
    const res = await app.request(
      "/compose",
      postJson(
        { ...INTENT_BODY, session: { surface: "web", sessionId: "s-1" } },
        { "x-kohaku-tenant": "acme" },
      ),
    );
    expect(res.status).toBe(200);
    const { spec } = (await res.json()) as { spec: UISpec };
    const requestId = res.headers.get("X-Request-Id");

    expect(cap.composed).toHaveLength(1);
    expect(Object.keys(cap.composed[0]!)).toEqual([
      "spec",
      "trace",
      "surface",
      "specHash",
      "sessionId",
      "tenant",
    ]);
    expect(cap.composed[0]).toMatchObject({
      surface: "web",
      specHash: await computeSpecHash(spec),
      sessionId: "s-1",
      tenant: "acme",
    });
    expect((cap.composed[0]!["trace"] as { correlationId?: string }).correlationId).toBe(requestId);

    expect(cap.fallback).toHaveLength(1);
    expect(Object.keys(cap.fallback[0]!)).toEqual([
      "spec",
      "reason",
      "kind",
      "surface",
      "specHash",
      "sessionId",
      "tenant",
      "correlationId",
    ]);
    expect(cap.fallback[0]).toMatchObject({
      kind: "generation",
      surface: "web",
      specHash: await computeSpecHash(spec),
      sessionId: "s-1",
      tenant: "acme",
      correlationId: requestId,
    });
  });

  it("/compose without a session id or tenant: the optional keys are absent, not undefined", async () => {
    const cap = capturing();
    const app = createKohakuRoutes(deps(cap.recorder));
    const res = await app.request("/compose", postJson(INTENT_BODY));
    expect(res.status).toBe(200);

    expect(Object.keys(cap.composed[0]!)).toEqual(["spec", "trace", "surface", "specHash"]);
    expect(Object.keys(cap.fallback[0]!)).toEqual([
      "spec",
      "reason",
      "kind",
      "surface",
      "specHash",
      "correlationId",
    ]);
  });

  it("/compose/stream records the same shapes, and its specHash equals the done event's", async () => {
    const cap = capturing();
    const app = createKohakuRoutes(deps(cap.recorder));
    const res = await app.request(
      "/compose/stream",
      postJson(
        { ...INTENT_BODY, session: { surface: "web", sessionId: "s-2" } },
        { "x-kohaku-tenant": "acme" },
      ),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const requestId = res.headers.get("X-Request-Id");

    expect(cap.composed).toHaveLength(1);
    expect(Object.keys(cap.composed[0]!)).toEqual([
      "spec",
      "trace",
      "surface",
      "specHash",
      "sessionId",
      "tenant",
    ]);
    const doneBlock = text.split("\n\n").find((b) => /(^|\n)event: done(\n|$)/.test(b));
    const doneData = doneBlock!.split("\n").find((l) => l.startsWith("data:"))!;
    const done = JSON.parse(doneData.slice("data:".length).trim()) as { specHash: string };
    expect(cap.composed[0]!["specHash"]).toBe(done.specHash);

    expect(cap.fallback).toHaveLength(1);
    expect(Object.keys(cap.fallback[0]!)).toEqual([
      "spec",
      "reason",
      "kind",
      "surface",
      "specHash",
      "sessionId",
      "tenant",
      "correlationId",
    ]);
    expect(cap.fallback[0]!["specHash"]).toBe(done.specHash);
    expect(cap.fallback[0]!["correlationId"]).toBe(requestId);
  });

  it("a non-fallback spec records composed only (no fallback call)", async () => {
    const cap = capturing();
    const app = createKohakuRoutes(deps(cap.recorder, { compose: fixedCtx() }));
    const res = await app.request("/compose", postJson(INTENT_BODY));
    expect(res.status).toBe(200);
    expect(cap.composed).toHaveLength(1);
    expect(cap.fallback).toHaveLength(0);
  });
});

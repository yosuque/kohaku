import type { ComposeContext } from "@kohaku-ui/composer";
import {
  createKohakuRoutes,
  type FixationsApi,
  type KohakuHostDeps,
  type LineageSummarizer,
  type PromotionsApi,
  type ViewRecorder,
} from "@kohaku-ui/host-rest";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import {
  type AuthzPort,
  computeStructureHash,
  type DomainPort,
  type FixationRecord,
  finalizeIntent,
  type LineageEventRecord,
  type LineageFilter,
  type SemanticPort,
  type StoragePort,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  createKohakuClient,
  hostErrorFromResponse,
  isKohakuHostError,
  KohakuHostError,
} from "../src/index.js";
import { readComposeStream } from "../src/stream.js";
import type { Transport } from "../src/transport.js";

// Exercises the typed client against an in-memory host-rest app.
// Injects Hono's app.request into the transport DI, without a real network (following host-rest's existing test style).

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

function stubStorage(overrides: Partial<StoragePort> = {}): StoragePort {
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
    ...overrides,
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

/** Fallback for normal compose (deterministic L0 markdown; no LLM needed). */
function fallbackFixed(): UISpec {
  return {
    kohaku: "0.1",
    intent: { canonical: "sales.trend", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "ignored",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["md1"] },
      { id: "md1", type: "presentMarkdown", props: { markdown: "fallback for normal compose" } },
    ],
    events: [],
    provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
  };
}

/** A valid pinnedSpec (for the fixation short-circuit SSE fast path; core components only). */
function validPinned(): UISpec {
  return {
    kohaku: "0.1",
    intent: { canonical: "sales.trend", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "pinned@v0",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["md1"] },
      { id: "md1", type: "presentMarkdown", props: { markdown: "Pinned view" } },
    ],
    events: [],
    provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
  };
}

// The real resolved hash of the {canonical:"sales.trend", params:{}} intent used below -- resolveIntent
// always re-derives via finalizeIntent regardless of what stubSemantic.normalize returns, so this must
// match that, not a placeholder (materializeFixation now verifies fixation.intentHash against it).
const REQUEST_INTENT = await finalizeIntent({ canonical: "sales.trend", params: {} });

async function makeFixation(): Promise<FixationRecord> {
  const pinnedSpec = validPinned();
  return {
    intentHash: REQUEST_INTENT.hash,
    canonical: "sales.trend",
    // The real structureHash of pinnedSpec (not a placeholder): materializeFixation now verifies this matches.
    structureHash: await computeStructureHash(pinnedSpec),
    pinnedSpec,
    fixatedAt: "2026-06-10T00:00:00Z",
    approver: { id: "tester" },
    catalogFingerprint: catalog.fingerprint,
  };
}

function composeCtx(storage?: StoragePort): ComposeContext {
  return {
    catalog,
    semantic: stubSemantic(),
    storage: storage ?? stubStorage(),
    llm: new FakeLlm(),
    policy: { fixedSpecs: { lookup: async () => fallbackFixed() } },
  };
}

/** A spy that records compose's recorder.composed calls (surface / tenant). */
/** A minimal, all-zero analytics summary body (shape-complete; used where only a couple of fields are probed). */
function emptySummary(events: number): ReturnType<LineageSummarizer> {
  return {
    events,
    composed: 0,
    tiers: { L0: 0, L1: 0, L2: 0 },
    cache: { hit: 0, miss: 0, bypass: 0, fixated: 0, other: 0 },
    fallback: { total: 0, byKind: { generation: 0, negotiation: 0, unspecified: 0 }, rate: 0 },
    durationMs: { count: 0, p50: null, p95: null, p99: null, max: null },
    topIntents: [],
    promotions: { generated: 0, used: 0, nominated: 0, judged: 0, reviewed: 0, published: 0, withdrawn: 0 },
    fixations: { fixated: 0, unfixated: 0 },
  };
}

function spyRecorder(): { api: ViewRecorder; composed: { surface: string; tenant?: string }[] } {
  const composed: { surface: string; tenant?: string }[] = [];
  return {
    composed,
    api: {
      async composed(args) {
        composed.push({ surface: args.surface, ...(args.tenant != null ? { tenant: args.tenant } : {}) });
      },
      async interacted() {},
    },
  };
}

function makeDeps(overrides: Partial<KohakuHostDeps> = {}): KohakuHostDeps {
  return {
    compose: composeCtx(),
    domain,
    authz: allowAuthz(),
    querySource: "sales",
    // Same as the demo: resolves the x-kohaku-tenant header to a tenant.
    tenant: (c) => c.req.header("x-kohaku-tenant") || undefined,
    ...overrides,
  };
}

/** Builds (client, recorder) from deps. Routes are mounted at "/api/kohaku" so baseUrl concatenation is also exercised. */
function makeClient(overrides: Partial<KohakuHostDeps> = {}, headers?: () => Record<string, string>) {
  const app = new Hono();
  app.route("/api/kohaku", createKohakuRoutes(makeDeps(overrides)));
  const transport: Transport = (url, init) => Promise.resolve(app.request(url, init));
  const client = createKohakuClient({
    baseUrl: "/api/kohaku",
    transport,
    ...(headers != null ? { headers } : {}),
  });
  return client;
}

describe("@kohaku-ui/client happy path", () => {
  it("compose returns a typed {spec, capability}", async () => {
    const client = makeClient();
    const view = await client.compose({ intent: { canonical: "sales.trend", params: {} } });
    expect(view.spec.intent.canonical).toBe("sales.trend");
    expect(view.capability).toBe("cap");
  });

  it("normalizeIntent returns {intent, source} (NL is source=llm)", async () => {
    const client = makeClient();
    const res = await client.normalizeIntent({ input: { kind: "nl", text: "Show me sales" } });
    expect(res.intent.canonical).toBe("sales.trend");
    expect(res.source).toBe("llm");
    expect(res.intent.hash).toMatch(/^sha256:/);
  });

  it("sendEvent returns a recomposed {spec, capability}", async () => {
    const client = makeClient();
    const view = await client.sendEvent({
      intent: { canonical: "sales.trend", params: {} },
      on: "root.click",
      payload: {},
    });
    expect(view.spec.intent.canonical).toBe("sales.trend");
    expect(view.capability).toBe("cap");
  });

  it("promotions.preview returns {html, sha256, ref, capability}, and throws NOT_FOUND when absent", async () => {
    const promotions: PromotionsApi = {
      async evaluateAndList() {
        return [];
      },
      async get(id) {
        return id === "art-1"
          ? { artifactId: id, status: "candidate", html: "<html>p</html>", sha256: "a".repeat(64), ref: REF }
          : null;
      },
      async act() {
        return {};
      },
      async approve() {
        return {};
      },
      async reject() {
        return {};
      },
      async withdraw() {
        return {};
      },
    };
    const client = makeClient({ promotions });

    const preview = await client.promotions.preview("art-1");
    expect(preview.html).toBe("<html>p</html>");
    expect(preview.sha256).toBe("a".repeat(64));
    expect(preview.ref).toBe(REF);
    expect(preview.capability).toBe("cap"); // token issued by allowAuthz

    const err = await client.promotions.preview("nope").catch((e: unknown) => e);
    expect(isKohakuHostError(err)).toBe(true);
    expect((err as KohakuHostError).code).toBe("NOT_FOUND");
  });

  it("catalog returns the components list and catalogVersion", async () => {
    const client = makeClient();
    const res = await client.catalog();
    expect(Array.isArray(res.components)).toBe(true);
    expect(res.components.length).toBeGreaterThan(0);
    expect(typeof res.catalogVersion).toBe("string");
  });

  it("promotions.list({status}) narrows via ?status= (read-only, no auto-nominate)", async () => {
    const promotions: PromotionsApi = {
      async evaluateAndList() {
        throw new Error("evaluateAndList (auto-nominate) must not run for a status-scoped list");
      },
      async get() {
        return null;
      },
      async act() {
        return {};
      },
      async approve() {
        return {};
      },
      async reject() {
        return {};
      },
      async withdraw() {
        return {};
      },
      async listByStatus(status) {
        return status === "published" ? [{ artifactId: "a1", status: "published" }] : [];
      },
    };
    const client = makeClient({ promotions });
    const list = await client.promotions.list({ status: "published" });
    expect(list).toEqual([{ artifactId: "a1", status: "published" }]);
  });

  it("analytics.summary returns the aggregated {window, summary} view", async () => {
    const analyticsSummarizer: LineageSummarizer = (events) => emptySummary(events.length);
    const client = makeClient({ analyticsSummarizer });
    const res = await client.analytics.summary();
    expect(res.window.limit).toBe(200);
    expect(res.summary.events).toBe(0);
  });

  it("analytics.summary passes since/until/limit through as query params", async () => {
    let seenOpts: { since?: string; until?: string } | null = null;
    const analyticsSummarizer: LineageSummarizer = (events, opts) => {
      seenOpts = { since: opts.since, until: opts.until };
      return emptySummary(events.length);
    };
    const client = makeClient({ analyticsSummarizer });
    const res = await client.analytics.summary({ since: "2026-01-01T00:00:00.000Z", limit: 50 });
    expect(seenOpts).toEqual({ since: "2026-01-01T00:00:00.000Z", until: undefined });
    expect(res.window.limit).toBe(50);
  });

  it("fixations.proposals returns the typed proposals list", async () => {
    const proposal = {
      intentHash: "sha256:" + "0".repeat(64),
      canonical: "sales.trend",
      params: {},
      uses: 5,
      stability: 0.8,
    };
    const fixations: FixationsApi = {
      async proposals() {
        return [proposal];
      },
      async list() {
        return [];
      },
      async fixate() {
        return {};
      },
      async unfixate() {},
    };
    const client = makeClient({ fixations });
    const result = await client.fixations.proposals();
    expect(result).toEqual([proposal]);
  });

  it("telemetry posts events through to the recorder (rendered / componentUsed)", async () => {
    const rendered: unknown[] = [];
    const componentUsed: unknown[] = [];
    const recorder: ViewRecorder = {
      async composed() {},
      async interacted() {},
      async rendered(args) {
        rendered.push(args);
      },
      async componentUsed(args) {
        componentUsed.push(args);
      },
    };
    const client = makeClient({ recorder });
    await client.telemetry([
      { kind: "rendered", specHash: "sha256:" + "a".repeat(64), surface: "web", durationMs: 12 },
      { kind: "componentUsed", artifactId: "art-1", surface: "web", outcome: "ok" },
    ]);
    expect(rendered).toEqual([
      { specHash: "sha256:" + "a".repeat(64), surface: "web", renderer: "unknown", durationMs: 12 },
    ]);
    expect(componentUsed).toEqual([{ artifactId: "art-1", surface: "web", outcome: "ok" }]);
  });
});

describe("@kohaku-ui/client binding() factory and request() URL joining", () => {
  it("binding() forwards baseUrl / headers to createBindingClient's default fetcher", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, headers: init?.headers ?? {} });
      return {
        status: 200,
        async json() {
          return { columns: [], rows: [], dataVersion: "v1" };
        },
        async text() {
          return "";
        },
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = createKohakuClient({
        baseUrl: "/api/kohaku",
        headers: () => ({ "x-kohaku-tenant": "tenant-a" }),
      });
      const binding = client.binding({ capability: "cap-x" });
      await binding.resolve("query://sales/summary?fy=2026");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toContain("/api/kohaku/binding/resolve");
      expect(calls[0]!.headers["x-kohaku-tenant"]).toBe("tenant-a");
      expect(calls[0]!.headers["Authorization"]).toBe("Bearer cap-x");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("request(): a bare (non-/, non-absolute) input is prefixed with baseUrl; a leading-/ or absolute input passes through unchanged", async () => {
    const seenUrls: string[] = [];
    const transport: Transport = (url) => {
      seenUrls.push(url);
      return Promise.resolve(new Response("ok", { status: 200 }));
    };
    const client = createKohakuClient({ baseUrl: "/api/kohaku", transport });

    await client.request("health"); // no leading "/" -> resolved by prefixing baseUrl
    await client.request("/other/health"); // leading "/" -> used as-is (not double-prefixed)
    await client.request("https://other-host.example/status"); // absolute -> used as-is

    expect(seenUrls).toEqual(["/api/kohakuhealth", "/other/health", "https://other-host.example/status"]);
  });
});

describe("@kohaku-ui/client error code discrimination (KohakuHostError)", () => {
  it("missing both input/intent throws BAD_REQUEST (400)", async () => {
    const client = makeClient();
    await expect(client.compose({})).rejects.toSatisfy((e: unknown) => {
      return isKohakuHostError(e) && e.code === "BAD_REQUEST" && e.status === 400;
    });
  });

  it("fixations.list on a host without fixation wiring throws NOT_IMPLEMENTED (501)", async () => {
    // makeDeps does not wire fixations, so it becomes 501.
    const client = makeClient();
    let caught: unknown;
    try {
      await client.fixations.list();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KohakuHostError);
    expect((caught as KohakuHostError).code).toBe("NOT_IMPLEMENTED");
    expect((caught as KohakuHostError).status).toBe(501);
  });

  it("analytics.summary on a host without an analyticsSummarizer throws NOT_IMPLEMENTED (501)", async () => {
    // makeDeps does not wire analyticsSummarizer, so it becomes 501.
    const client = makeClient();
    let caught: unknown;
    try {
      await client.analytics.summary();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KohakuHostError);
    expect((caught as KohakuHostError).code).toBe("NOT_IMPLEMENTED");
    expect((caught as KohakuHostError).status).toBe(501);
  });

  it("a 409 PROMOTION_NOT_PUBLISHED envelope's error.status is exposed as promotionStatus (distinct from the HTTP status)", () => {
    const err = hostErrorFromResponse(409, {
      error: { code: "PROMOTION_NOT_PUBLISHED", message: "not published", status: "judge_failed" },
    });
    expect(err.code).toBe("PROMOTION_NOT_PUBLISHED");
    expect(err.status).toBe(409);
    expect(err.promotionStatus).toBe("judge_failed");
  });

  it("an envelope without error.status leaves promotionStatus undefined", () => {
    const err = hostErrorFromResponse(400, { error: { code: "BAD_REQUEST", message: "bad" } });
    expect(err.promotionStatus).toBeUndefined();
  });
});

describe("@kohaku-ui/client headers hook (tenant propagation)", () => {
  it("the headers hook's x-kohaku-tenant propagates to the server's recorder.tenant", async () => {
    const recorder = spyRecorder();
    const client = makeClient({ recorder: recorder.api }, () => ({ "x-kohaku-tenant": "acme" }));
    await client.compose({ intent: { canonical: "sales.trend", params: {} } });
    expect(recorder.composed).toHaveLength(1);
    expect(recorder.composed[0]!.tenant).toBe("acme");
  });

  it("without a headers hook, tenant is not carried (single-tenant equivalent)", async () => {
    const recorder = spyRecorder();
    const client = makeClient({ recorder: recorder.api });
    await client.compose({ intent: { canonical: "sales.trend", params: {} } });
    expect(recorder.composed[0]!.tenant).toBeUndefined();
  });
});

describe("@kohaku-ui/client per-request cancellation (AbortSignal)", () => {
  it("opts.signal is passed to the transport's RequestInit.signal, and if already aborted the request is aborted", async () => {
    const seenSignals: (AbortSignal | null | undefined)[] = [];
    const app = new Hono();
    app.route("/api/kohaku", createKohakuRoutes(makeDeps()));
    // A transport that honors signal the same way as fetch (rejects with AbortError when already aborted).
    const transport: Transport = (url, init) => {
      seenSignals.push(init?.signal);
      if (init?.signal?.aborted) {
        return Promise.reject(new DOMException("the request was aborted", "AbortError"));
      }
      return Promise.resolve(app.request(url, init));
    };
    const client = createKohakuClient({ baseUrl: "/api/kohaku", transport });

    // A non-aborted signal is propagated as-is to the transport (= fetch), and the request succeeds.
    const controller = new AbortController();
    await client.compose({ intent: { canonical: "sales.trend", params: {} } }, { signal: controller.signal });
    expect(seenSignals[0]).toBe(controller.signal);

    // Calling with an already-aborted signal makes the transport abort (AbortError propagates as-is).
    controller.abort();
    await expect(
      client.compose({ intent: { canonical: "sales.trend", params: {} } }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    // Existing calls without opts do not carry a signal (backward compatibility).
    await client.compose({ intent: { canonical: "sales.trend", params: {} } });
    expect(seenSignals[2]).toBeUndefined();
  });
});

describe("@kohaku-ui/client lineage query", () => {
  it("type / limit are passed to the server's filter", async () => {
    const seen: LineageFilter[] = [];
    const events: LineageEventRecord[] = [
      { id: "e1", ts: "2026-06-10T00:00:00Z", actor: { kind: "system" }, type: "view.composed", payload: {} },
    ];
    const storage = stubStorage({
      async listLineage(filter = {}) {
        seen.push(filter);
        return events;
      },
    });
    const client = makeClient({ compose: composeCtx(storage) });
    const result = await client.lineage({ type: ["view.composed"], limit: 10 });
    expect(result).toHaveLength(1);
    expect(seen[0]!.type).toEqual(["view.composed"]);
    expect(seen[0]!.limit).toBe(10);
  });

  it("since / until are passed to the server's filter (until is normalized to ISO8601 canonical form)", async () => {
    const seen: LineageFilter[] = [];
    const storage = stubStorage({
      async listLineage(filter = {}) {
        seen.push(filter);
        return [];
      },
    });
    const client = makeClient({ compose: composeCtx(storage) });
    await client.lineage({ since: "2026-06-01", until: "2026-07-09" });
    // On the route side it is normalized to ISO8601 canonical form by the same rule as /analytics before being passed to storage.
    expect(seen[0]!.since).toBe("2026-06-01T00:00:00.000Z");
    expect(seen[0]!.until).toBe("2026-07-09T00:00:00.000Z");
  });

  it("intentHash is passed through to the server's filter", async () => {
    const seen: LineageFilter[] = [];
    const storage = stubStorage({
      async listLineage(filter = {}) {
        seen.push(filter);
        return [];
      },
    });
    const client = makeClient({ compose: composeCtx(storage) });
    await client.lineage({ intentHash: "sha256:" + "a".repeat(64) });
    expect(seen[0]!.intentHash).toBe("sha256:" + "a".repeat(64));
  });
});

describe("@kohaku-ui/client composeStream(SSE)", () => {
  it("the fixation short-circuit fast path terminates with spec (final:true) → done", async () => {
    const client = makeClient({ fixationLookup: async () => await makeFixation() });
    const events = [];
    for await (const ev of client.composeStream({ intent: { canonical: "sales.trend", params: {} } })) {
      events.push(ev);
    }
    expect(events).toHaveLength(2);
    expect(events[0]!.kind).toBe("spec");
    if (events[0]!.kind === "spec") {
      expect(events[0]!.final).toBe(true);
      expect(events[0]!.spec.intent.canonical).toBe("sales.trend");
      expect(events[0]!.capability).toBe("cap");
    }
    expect(events[1]!.kind).toBe("done");
    if (events[1]!.kind === "done") {
      expect(events[1]!.cache).toBe("fixated");
    }
  });

  it("an invalid body before the stream starts (both missing) throws BAD_REQUEST (400)", async () => {
    const client = makeClient();
    const iterate = async (): Promise<void> => {
      for await (const _ev of client.composeStream({})) {
        // unreachable (throws before start)
      }
    };
    await expect(iterate()).rejects.toSatisfy(
      (e: unknown) => isKohakuHostError(e) && e.code === "BAD_REQUEST",
    );
  });

  it("a disconnected stream (EOF before done|error) throws instead of completing silently (C6, REST-STR-003)", async () => {
    // A transport whose SSE body closes right after a skeleton `spec` event, without ever sending
    // done or error — simulating a dropped connection mid-stream.
    const transport: Transport = () =>
      Promise.resolve(
        new Response(sseStream(["event: spec\n", 'data: {"spec":{"id":"s"},"final":false}\n\n']), {
          status: 200,
        }),
      );
    const client = createKohakuClient({ baseUrl: "/api/kohaku", transport });
    const iterate = async (): Promise<void> => {
      for await (const ev of client.composeStream({ intent: { canonical: "sales.trend", params: {} } })) {
        expect(ev.kind).toBe("spec"); // the one event that did arrive is still yielded before the throw
      }
    };
    await expect(iterate()).rejects.toSatisfy((e: unknown) => isKohakuHostError(e) && e.code === "INTERNAL");
  });
});

// --- Unit tests for SSE framing (readComposeStream) ------------------------------

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe("readComposeStream SSE framing", () => {
  it("yields skeleton (final:false) → patch → done in order", async () => {
    const wire = [
      "event: spec\n",
      'data: {"spec":{"id":"s"},"capability":"c","final":false}\n\n',
      "event: patch\n",
      'data: {"patch":{"upsert":[]}}\n\n',
      "event: done\n",
      'data: {"specHash":"sha256:h","tier":"L1","cache":"miss"}\n\n',
    ];
    const events = await collect(readComposeStream(sseStream(wire)));
    expect(events.map((e) => e.kind)).toEqual(["spec", "patch", "done"]);
    expect(events[0]).toMatchObject({ kind: "spec", capability: "c", final: false });
    expect(events[2]).toMatchObject({ kind: "done", specHash: "sha256:h", tier: "L1", cache: "miss" });
  });

  it("discriminates the error event", async () => {
    const events = await collect(
      readComposeStream(
        sseStream(['event: error\ndata: {"error":{"code":"COMPOSE_FAILED","message":"boom"}}\n\n']),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: "error", error: { code: "COMPOSE_FAILED", message: "boom" } });
  });

  it("handles CRLF, multi-line data, comment lines, and unknown events correctly", async () => {
    // Comment lines (:) and unknown events (heartbeat) are ignored, and multi-line data is newline-joined before JSON.parse.
    const events = await collect(
      readComposeStream(
        sseStream([
          ": this comment line is ignored\r\n",
          "event: heartbeat\r\ndata: ignored\r\n\r\n",
          "event: done\r\n",
          'data: {"specHash":"h",\r\n',
          'data: "tier":"L0","cache":"fixated"}\r\n\r\n',
        ]),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "done", specHash: "h", tier: "L0", cache: "fixated" });
  });

  it("does not drop events even when a chunk boundary splits an event", async () => {
    // Split one event at arbitrary positions and stream it.
    const full = 'event: spec\ndata: {"spec":{"id":"s"},"final":true}\n\n';
    const chunks = [full.slice(0, 5), full.slice(5, 20), full.slice(20)];
    const events = await collect(readComposeStream(sseStream(chunks)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "spec", final: true });
  });
});

describe("session.locale wire passthrough", () => {
  /** A client whose transport records every JSON request body before delegating to the host app. */
  function makeCapturingClient() {
    const app = new Hono();
    app.route("/api/kohaku", createKohakuRoutes(makeDeps()));
    const bodies: Record<string, unknown>[] = [];
    const transport: Transport = (url, init) => {
      if (init?.body != null) bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Promise.resolve(app.request(url, init));
    };
    return { client: createKohakuClient({ baseUrl: "/api/kohaku", transport }), bodies };
  }

  it("compose / normalizeIntent / sendEvent carry session.locale (and input.locale) verbatim", async () => {
    const { client, bodies } = makeCapturingClient();
    await client.compose({
      intent: { canonical: "sales.trend", params: {} },
      session: { surface: "web", locale: "ja" },
    });
    await client.normalizeIntent({
      input: { kind: "nl", text: "show sales", locale: "ja" },
      session: { surface: "chat", locale: "ja" },
    });
    await client.sendEvent({
      intent: { canonical: "sales.trend", params: {} },
      on: "root.click",
      payload: {},
      session: { surface: "web", locale: "ja" },
    });
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect((body["session"] as Record<string, unknown>)["locale"]).toBe("ja");
    }
    expect((bodies[1]!["input"] as Record<string, unknown>)["locale"]).toBe("ja");
  });

  it("omits locale from the wire when the session does not carry it", async () => {
    const { client, bodies } = makeCapturingClient();
    await client.compose({ intent: { canonical: "sales.trend", params: {} }, session: { surface: "web" } });
    expect("locale" in (bodies[0]!["session"] as Record<string, unknown>)).toBe(false);
  });
});

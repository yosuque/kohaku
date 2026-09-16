import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ComposeContext } from "@kohaku-ui/composer";
import type { ViewRecorder } from "@kohaku-ui/host-core";
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
  type DomainPort,
  type FixationRecord,
  type JsonObject,
  parseSpec,
  type Scope,
  sha256Hex,
  type TabularData,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { beforeAll, describe, expect, it } from "vitest";
import {
  attachKohakuToMcpServer,
  CAPABILITY_META_KEY,
  defaultMcpListCacheHints,
  INITIAL_DATA_META_KEY,
  KOHAKU_MCP_LIST_CACHE_HINT,
  RENDERER_RESOURCE_CACHE_HINT,
  RENDERER_RESOURCE_URI,
  RESOURCE_MIME_TYPE,
  RESOURCE_URI_META_KEY,
  UI_META_KEY,
  VISIBILITY_META_KEY,
} from "../src/index.js";
// Test-only per-ref timeout / overall-deadline overrides (internal hooks not exported from the public API = index.ts).
import { __setPreresolveTimeoutMsForTest, __setPreresolveTotalTimeoutMsForTest } from "../src/server.js";
import { connectModern } from "./connect-modern.js";

const TREND_REF = "query://sales/trend?granularity=month&metric=revenue";

/** A small helper that extracts the modern (nested) form _meta.ui in a typed way. */
function uiMeta(
  meta: Record<string, unknown> | undefined,
): { resourceUri?: string; visibility?: string[] } | undefined {
  return meta?.[UI_META_KEY] as { resourceUri?: string; visibility?: string[] } | undefined;
}

/**
 * Extracts the compose-issued capability token from a tool result's `_meta` (moved out of model-visible
 * `structuredContent` — see server.ts's composeAndPackage / meta.ts's CAPABILITY_META_KEY).
 */
function capabilityOf(result: { _meta?: Record<string, unknown> }): string {
  const value = result._meta?.[CAPABILITY_META_KEY];
  if (typeof value !== "string") throw new Error("capability missing from _meta");
  return value;
}

const DATA: TabularData = {
  columns: [
    { key: "month", type: "string" },
    { key: "revenue", type: "number" },
  ],
  rows: [
    { month: "2026-04", revenue: 100 },
    { month: "2026-05", revenue: 200 },
  ],
  dataVersion: "sales@seed-1",
};

/** Simple authz: token = "cap:" + concatenated allowed refs */
const authz: AuthzPort = {
  async issueCapability(_p, scopes: Scope[]) {
    return `cap:${scopes.map((s) => s.ref).join("|")}`;
  },
  async verify(token, req) {
    const ok =
      token.startsWith("cap:") &&
      token
        .slice(4)
        .split("|")
        .some((p) => req.ref.startsWith(p));
    return ok ? { ok: true, principal: { id: "tester" } } : { ok: false, reason: "scope" };
  },
};

const domain: DomainPort = {
  async listOperations() {
    return [];
  },
  async invoke(op) {
    if (op !== "trend") throw new Error("unknown op");
    return DATA;
  },
};

function makeComposeCtx(): ComposeContext {
  const cache = new Map<string, UISpec>();
  return {
    catalog: resolveCatalog(coreCatalog),
    llm: {
      provider: "fake",
      modelId: "fake",
      async generateObject() {
        throw new Error("LLM should not be called (fixedSpecs)");
      },
      async generateText() {
        throw new Error("no");
      },
    },
    semantic: {
      async normalize(input) {
        return {
          canonical: "sales.trend",
          params: input.kind === "gui" ? { ...input.current?.params, ...input.params } : {},
          hash: "",
        };
      },
      async resolveQuery() {
        return { uri: TREND_REF };
      },
      async dataVersion() {
        return "sales@seed-1";
      },
    },
    storage: {
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
    },
    policy: {
      fixedSpecs: {
        async lookup() {
          return (intentArg, refs): UISpec => ({
            kohaku: "0.1",
            intent: intentArg,
            dataVersion: "x",
            components: [
              { id: "root", type: "layout.stack", props: {}, children: ["t", "c"] },
              { id: "t", type: "text.heading", props: { level: 2, text: "Monthly revenue trend" } },
              {
                id: "c",
                type: "presentChart",
                props: { kind: "line", x: "month", y: "revenue" },
                data: { $ref: refs[0]!.uri },
              },
            ],
            events: [],
            provenance: { tier: "L0", composedBy: "test", cache: "miss" },
          });
        },
      },
    },
  };
}

describe("MCP Apps profile (SEP-1865)", () => {
  let client: Client;

  beforeAll(async () => {
    const server = new McpServer({ name: "kohaku-test", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      { compose: makeComposeCtx(), domain, authz, querySource: "sales" },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  it("MCPAPP-RES-001: ui:// resource is text/html;profile=mcp-app", async () => {
    const resources = await client.listResources();
    const renderer = resources.resources.find((r) => r.uri === RENDERER_RESOURCE_URI);
    expect(renderer).toBeDefined();
    expect(renderer!.mimeType).toBe(RESOURCE_MIME_TYPE);

    const read = await client.readResource({ uri: RENDERER_RESOURCE_URI });
    expect(read.contents[0]!.mimeType).toBe(RESOURCE_MIME_TYPE);
    expect((read.contents[0] as { text?: string }).text).toContain("renderer");
  });

  it("tool declaration: compose is model-visible + resourceUri, binding/event are app-only", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    const composeTool = byName.get("kohaku_compose")!;
    // legacy (flat) form
    expect(composeTool._meta?.[RESOURCE_URI_META_KEY]).toBe(RENDERER_RESOURCE_URI);
    expect(composeTool._meta?.[VISIBILITY_META_KEY]).toEqual(["model"]);
    // modern (nested) form (canonical since the formalization of SEP-1865; ChatGPT etc. look at it first)
    expect(uiMeta(composeTool._meta)).toEqual({
      resourceUri: RENDERER_RESOURCE_URI,
      visibility: ["model"],
    });

    // binding/event are app-only. visibility is ["app"] in both legacy and modern.
    const binding = byName.get("kohaku_resolve_binding")!;
    expect(binding._meta?.[VISIBILITY_META_KEY]).toEqual(["app"]);
    expect(uiMeta(binding._meta)?.visibility).toEqual(["app"]);
    // resolve_binding has no resourceUri (app-only, does not open a view).
    expect(binding._meta?.[RESOURCE_URI_META_KEY]).toBeUndefined();
    expect(uiMeta(binding._meta)?.resourceUri).toBeUndefined();

    const eventTool = byName.get("kohaku_event")!;
    expect(eventTool._meta?.[VISIBILITY_META_KEY]).toEqual(["app"]);
    expect(uiMeta(eventTool._meta)).toEqual({
      resourceUri: RENDERER_RESOURCE_URI,
      visibility: ["app"],
    });
  });

  it("MCPAPP-FBK-001: compose result has a non-empty text fallback + structured Spec", async () => {
    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });
    const content = (result.content as { type: string; text: string }[])[0]!;
    expect(content.type).toBe("text");
    expect(content.text).toContain("Monthly revenue trend");
    expect(content.text.length).toBeGreaterThan(20);

    const structured = result.structuredContent as { spec: unknown };
    const spec = parseSpec(structured.spec);
    expect(spec.provenance.tier).toBe("L0");
    // The capability token rides _meta, not structuredContent (see CAPABILITY_META_KEY's doc comment): a
    // bearer write token must never enter the model's context.
    expect(structured).not.toHaveProperty("capability");
    expect(capabilityOf(result)).toContain(TREND_REF);
    // The tool result's (CallToolResult) _meta also carries resourceUri in both forms.
    expect(result._meta?.[RESOURCE_URI_META_KEY]).toBe(RENDERER_RESOURCE_URI);
    expect(uiMeta(result._meta)?.resourceUri).toBe(RENDERER_RESOURCE_URI);
  });

  it("app-only binding resolution: requires capability (read from _meta), data flows only from the iframe", async () => {
    const composeResult = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });
    const capability = capabilityOf(composeResult);

    const ok = await client.callTool({
      name: "kohaku_resolve_binding",
      arguments: { ref: TREND_REF, capability },
    });
    const data = (ok.structuredContent as { data: TabularData }).data;
    expect(data.rows).toHaveLength(2);

    const denied = await client.callTool({
      name: "kohaku_resolve_binding",
      arguments: { ref: "query://sales/records?limit=1", capability },
    });
    expect(denied.isError).toBe(true);
  });

  it("artifact integrity helper: sha256Hex is stable (regression guard)", async () => {
    expect(await sha256Hex("x")).toHaveLength(64);
  });
});

// Characterization (pre-refactor): pins the exact ref-parsing / verify / domain.invoke behavior of
// kohaku_resolve_binding before the parse/merge step moves to host-core's parseInvokableRef. The
// capability here always verifies (so these tests isolate the parse/merge step from scope checks,
// which are already covered by the "app-only binding resolution" test above).
describe("kohaku_resolve_binding ref parsing (server.ts / host-core parity)", () => {
  function captureDomain(): {
    domain: DomainPort;
    calls: { op: string; args: JsonObject }[];
  } {
    const calls: { op: string; args: JsonObject }[] = [];
    return {
      calls,
      domain: {
        async listOperations() {
          return [];
        },
        async invoke(op, args) {
          calls.push({ op, args: args as JsonObject });
          return DATA;
        },
      },
    };
  }

  function alwaysAllowAuthz(): { authz: AuthzPort; verifiedRefs: string[] } {
    const verifiedRefs: string[] = [];
    return {
      verifiedRefs,
      authz: {
        async issueCapability() {
          return "cap";
        },
        async verify(_token, req) {
          verifiedRefs.push(req.ref);
          return { ok: true, principal: { id: "tester" } };
        },
      },
    };
  }

  async function attach(domain: DomainPort, authz: AuthzPort): Promise<Client> {
    const server = new McpServer({ name: "kohaku-resolve-ref", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      { compose: makeComposeCtx(), domain, authz, querySource: "sales" },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    const client = new Client({ name: "resolve-ref-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it("plain ref: verifies against base.raw and invokes with base.params only", async () => {
    const { domain, calls } = captureDomain();
    const { authz, verifiedRefs } = alwaysAllowAuthz();
    const client = await attach(domain, authz);

    const res = await client.callTool({
      name: "kohaku_resolve_binding",
      arguments: { ref: "query://sales/records?fy=2026", capability: "cap" },
    });

    expect(res.isError).toBeFalsy();
    expect(verifiedRefs).toEqual(["query://sales/records?fy=2026"]);
    expect(calls).toEqual([{ op: "records", args: { fy: "2026" } }]);
  });

  it("ref with reserved params: verifies against base only, merges reserved into invoke args", async () => {
    const { domain, calls } = captureDomain();
    const { authz, verifiedRefs } = alwaysAllowAuthz();
    const client = await attach(domain, authz);

    const res = await client.callTool({
      name: "kohaku_resolve_binding",
      arguments: {
        ref: "query://sales/records?_cursor=100:v1&_dir=desc&_limit=50&_sort=revenue&fy=2026",
        capability: "cap",
      },
    });

    expect(res.isError).toBeFalsy();
    expect(verifiedRefs).toEqual(["query://sales/records?fy=2026"]);
    expect(calls).toEqual([
      {
        op: "records",
        args: { fy: "2026", _cursor: "100:v1", _dir: "desc", _limit: "50", _sort: "revenue" },
      },
    ]);
  });

  it("unknown reserved param: tool error naming the key, no verify/invoke performed", async () => {
    const { domain, calls } = captureDomain();
    const { authz, verifiedRefs } = alwaysAllowAuthz();
    const client = await attach(domain, authz);

    const res = await client.callTool({
      name: "kohaku_resolve_binding",
      arguments: { ref: "query://sales/records?_tenant=other&fy=2026", capability: "cap" },
    });

    expect(res.isError).toBe(true);
    expect((res.content as { type: string; text: string }[])[0]!.text).toContain(
      'unknown reserved parameter "_tenant"',
    );
    expect(verifiedRefs).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("source mismatch: tool error naming the unknown source, no verify/invoke performed", async () => {
    const { domain, calls } = captureDomain();
    const { authz, verifiedRefs } = alwaysAllowAuthz();
    const client = await attach(domain, authz);

    const res = await client.callTool({
      name: "kohaku_resolve_binding",
      arguments: { ref: "query://other/records?fy=2026", capability: "cap" },
    });

    expect(res.isError).toBe(true);
    expect((res.content as { type: string; text: string }[])[0]!.text).toBe('unknown query source "other"');
    expect(verifiedRefs).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("audit recording fail-open (host-mcp-apps, #2)", () => {
  it("kohaku_compose returns the Spec even when onComposed throws, and the error reaches the observability hook", async () => {
    const seen: { endpoint: string; error: unknown }[] = [];
    const server = new McpServer({ name: "kohaku-failopen", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      {
        compose: makeComposeCtx(),
        domain,
        authz,
        querySource: "sales",
        // The audit record is fail-open: an onComposed failure does not drag down UI delivery.
        async onComposed() {
          throw new Error("onComposed recording failed (test)");
        },
        onError: (info) => {
          seen.push({ endpoint: info.endpoint, error: info.error });
        },
      },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    const client = new Client({ name: "failopen-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });

    // Even if the audit record fails, the result is normal (structuredContent containing the Spec is returned, not isError).
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { spec: unknown };
    expect(parseSpec(structured.spec).provenance.tier).toBe("L0");
    // The failure is reported to the observation hook (endpoint = compose).
    expect(seen).toHaveLength(1);
    expect(seen[0]!.endpoint).toBe("compose");
    expect(seen[0]!.error).toBeInstanceOf(Error);
  });
});

describe("kohaku_event payload / intent.params nesting depth cap (JsonObjectSchema, like kohaku_action)", () => {
  /** Builds a JSON object literal nested `depth` levels deep (a bare `{leaf:true}` is depth 1). Mirrors
   * host-rest/test/schemas.test.ts's own nestedObject helper. */
  function nestedObject(depth: number): Record<string, unknown> {
    let obj: Record<string, unknown> = { leaf: true };
    for (let i = 1; i < depth; i++) {
      obj = { nested: obj };
    }
    return obj;
  }

  async function connect(): Promise<Client> {
    const server = new McpServer({ name: "kohaku-event-depth", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      { compose: makeComposeCtx(), domain, authz, querySource: "sales" },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    const client = new Client({ name: "event-depth-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it("a payload nested 33 levels deep (over the 32 limit) is rejected by the SDK's own input validation before the handler runs", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "kohaku_event",
      arguments: {
        intent: { canonical: "sales.trend", params: {} },
        on: "c.pointClick",
        payload: nestedObject(33),
      },
    });
    // The SDK validates inputSchema before ever calling our registerTool callback (an unreachable handler,
    // not a caught exception from within it), and reports the failure as an isError tool result rather than
    // a JSON-RPC-level rejection.
    expect(result.isError).toBe(true);
    expect((result.content as { type: string; text: string }[])[0]!.text).toContain(
      "object nesting exceeds the maximum depth (32)",
    );
  });

  it("an intent.params nested 33 levels deep (over the 32 limit) is rejected by the SDK's own input validation before the handler runs", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "kohaku_event",
      arguments: {
        intent: { canonical: "sales.trend", params: nestedObject(33) },
        on: "c.pointClick",
        payload: {},
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { type: string; text: string }[])[0]!.text).toContain(
      "object nesting exceeds the maximum depth (32)",
    );
  });

  it("a payload nested exactly 32 levels deep (at the limit) passes schema validation and reaches the handler", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "kohaku_event",
      arguments: {
        intent: { canonical: "sales.trend", params: {} },
        on: "c.pointClick",
        payload: nestedObject(32),
      },
    });
    expect(result.isError).toBeFalsy();
  });
});

describe("correlation id: the tool call's JSON-RPC request id reaches ComposeTrace.correlationId", () => {
  it("kohaku_compose threads extra.requestId through composeForTool -> composeWithFixation -> compose()", async () => {
    let correlationId: string | undefined;
    const server = new McpServer({ name: "kohaku-correlation", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      {
        compose: makeComposeCtx(),
        domain,
        authz,
        querySource: "sales",
        async onComposed(_spec, trace) {
          correlationId = trace.correlationId;
        },
      },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    const client = new Client({ name: "correlation-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });

    expect(result.isError).toBeFalsy();
    // The exact id (the JSON-RPC request id the SDK assigned to this call) is an implementation detail;
    // what this test guarantees is that *some* correlation id — not undefined — reaches the trace.
    expect(correlationId).toBeDefined();
    expect(typeof correlationId).toBe("string");
  });
});

/**
 * Captures every tool handler function passed to `server.registerTool(name, config, handler)` by
 * intercepting the call, keyed by tool name — lets a test invoke a handler directly with a synthetic
 * `ServerContext`-shaped `extra`, bypassing the MCP protocol/transport layer entirely.
 */
type CapturedToolHandler = (args: unknown, extra: Record<string, unknown>) => Promise<{ content: unknown[] }>;
function captureToolHandlers(server: McpServer): Record<string, CapturedToolHandler> {
  const handlers: Record<string, CapturedToolHandler> = {};
  const original = (server.registerTool as unknown as (...args: unknown[]) => unknown).bind(server);
  (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (
    ...args: unknown[]
  ) => {
    const [name, , handler] = args as [string, unknown, CapturedToolHandler];
    handlers[name] = handler;
    return original(...args);
  };
  return handlers;
}

/** Minimal synthetic `ServerContext` for directly invoking a captured handler (only the fields requestContextOf reads). */
function fakeServerContext(mcpReq: { signal: AbortSignal; id: string }): Record<string, unknown> {
  return { mcpReq };
}

describe("requestContextOf: reads the per-call abort signal and JSON-RPC id from ServerContext.mcpReq", () => {
  it("the compose correlation id comes from ctx.mcpReq.id", async () => {
    let correlationId: string | undefined;
    const server = new McpServer({ name: "kohaku-mcpreq-id", version: "0.1.0" });
    const handlers = captureToolHandlers(server);
    attachKohakuToMcpServer(
      server,
      {
        compose: makeComposeCtx(),
        domain,
        authz,
        querySource: "sales",
        async onComposed(_spec, trace) {
          correlationId = trace.correlationId;
        },
      },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );

    await handlers["kohaku_compose"]!(
      { question: "Monthly revenue trend" },
      fakeServerContext({ signal: new AbortController().signal, id: "v2-req-1" }),
    );
    expect(correlationId).toBe("v2-req-1");
  });

  it("kohaku_action's synchronous aborted check reads ctx.mcpReq.signal", async () => {
    const server = new McpServer({ name: "kohaku-mcpreq-signal", version: "0.1.0" });
    const handlers = captureToolHandlers(server);
    attachKohakuToMcpServer(
      server,
      { compose: makeComposeCtx(), domain, authz, querySource: "sales" },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );

    const notAborted = new AbortController();
    const notCancelled = await handlers["kohaku_action"]!(
      { action: "whatever", payload: {}, capability: "cap:whatever" },
      fakeServerContext({ signal: notAborted.signal, id: "r1" }),
    );
    expect((notCancelled.content[0] as { text: string }).text).not.toBe("cancelled");

    const aborted = new AbortController();
    aborted.abort();
    const cancelled = await handlers["kohaku_action"]!(
      { action: "whatever", payload: {}, capability: "cap:whatever" },
      fakeServerContext({ signal: aborted.signal, id: "r2" }),
    );
    expect((cancelled.content[0] as { text: string }).text).toBe("cancelled");
  });
});

/**
 * Wraps `transport.send` to capture the raw outgoing JSON-RPC envelope for the next `tools/call`
 * result, keyed by request id. SDK v2's client-side `CallToolResult` type declares `resultType` a
 * `WireOnlyResultKey` and strips it before the parsed result reaches application code (it is
 * "consumed by the SDK's protocol layer" — see the SDK's own type docs) — the same
 * `client.callTool(...)` round-trip that pinned this field under SDK v1's passthrough zod schema
 * therefore can no longer observe it on `result["resultType"]`. This helper reads the wire bytes
 * the server transport actually sends instead, which is where `resultType` still needs to be
 * observed (host-mcp-apps stamps it there for real MCP hosts that read the raw wire, not this
 * SDK's own parsed client object).
 */
function captureSentResultTypes(
  serverTransport: InstanceType<typeof InMemoryTransport>,
): Map<unknown, unknown> {
  const byRequestId = new Map<unknown, unknown>();
  const rawSend = (
    serverTransport as unknown as { send: (message: unknown, options?: unknown) => Promise<void> }
  ).send.bind(serverTransport);
  (serverTransport as unknown as { send: (message: unknown, options?: unknown) => Promise<void> }).send = (
    message: unknown,
    options?: unknown,
  ) => {
    const m = message as { id?: unknown; result?: { resultType?: unknown } };
    if (m.result != null && "resultType" in m.result) byRequestId.set(m.id, m.result.resultType);
    return rawSend(message, options);
  };
  return byRequestId;
}

describe("MCP 2026-07-28: every tool result carries resultType (SEP-2322)", () => {
  it('a successful result (kohaku_compose) has resultType "complete" on the wire', async () => {
    const server = new McpServer({ name: "kohaku-result-type", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      { compose: makeComposeCtx(), domain, authz, querySource: "sales" },
      {
        rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>",
      },
    );
    const client = new Client({ name: "result-type-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const sentResultTypes = captureSentResultTypes(serverTransport);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });
    expect(result.isError).toBeFalsy();
    // This profile never produces an MRTR interim result, so every success is "complete". Observed on the
    // raw wire message (see captureSentResultTypes's doc comment) — the SDK v2 client itself strips
    // resultType from the parsed CallToolResult it hands back, but the wire byte a real MCP host reads is
    // unaffected: host-mcp-apps's own safeTool stamp is what puts it there in the first place, and neither
    // the SDK nor this InMemoryTransport pair removes or overrides it before it is sent.
    expect([...sentResultTypes.values()]).toContain("complete");
  });

  it('an error result (kohaku_resolve_binding, unknown source) also has resultType "complete" on the wire', async () => {
    const server = new McpServer({ name: "kohaku-result-type-error", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      { compose: makeComposeCtx(), domain, authz, querySource: "sales" },
      {
        rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>",
      },
    );
    const client = new Client({ name: "result-type-error-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const sentResultTypes = captureSentResultTypes(serverTransport);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "kohaku_resolve_binding",
      arguments: { ref: "query://other/records", capability: "cap:x" },
    });
    expect(result.isError).toBe(true);
    // An error is still a *complete* result (not the MRTR "input_required" interim shape this profile never
    // produces) — resultType must be stamped on the error path too, not only on success. See the previous
    // test's comment for why this reads the raw wire message rather than the parsed client result.
    expect([...sentResultTypes.values()]).toContain("complete");
  });
});

// connectModern (the SDK v2 modern-era in-process connection helper) now lives in ./connect-modern.ts,
// shared with the MCP Tasks extension work's tests — see that file's doc comment for why it exists.

describe("MCP 2026-07-28 response caching (SEP-2549): ttlMs/cacheScope", () => {
  // Unlike resultType (see captureSentResultTypes's doc comment above), ttlMs/cacheScope are NOT part of
  // the SDK v2 client's WireOnlyResultKey stripping (only "resultType" is — see
  // @modelcontextprotocol/client's StripWireOnly type), so they survive on the parsed client result and can
  // be asserted directly without intercepting the raw wire message. They DO however require the client to
  // have actually negotiated the modern (2026-07-28) protocol era — see connectModern's doc comment.

  it("resources/read on the renderer resource carries RENDERER_RESOURCE_CACHE_HINT by default, even when the McpServer constructor is not given any cacheHints", async () => {
    // Deliberately mirrors the describe("MCP Apps profile (SEP-1865)") beforeAll server above: a plain
    // `new McpServer({...})` with no cacheHints option, to prove the per-resource hint is attached via this
    // package's own registerResource(..., {cacheHint}) call and does not depend on the caller opting into
    // ServerOptions.cacheHints.
    const buildServer = () => {
      const server = new McpServer({ name: "kohaku-cache-hints-default", version: "0.1.0" });
      attachKohakuToMcpServer(
        server,
        { compose: makeComposeCtx(), domain, authz, querySource: "sales" },
        {
          rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>",
        },
      );
      return server;
    };
    const { client, close } = await connectModern(buildServer, "cache-hints-default-client");
    try {
      const read = await client.readResource({ uri: RENDERER_RESOURCE_URI });
      expect((read as unknown as { ttlMs?: number }).ttlMs).toBe(RENDERER_RESOURCE_CACHE_HINT.ttlMs);
      expect((read as unknown as { cacheScope?: string }).cacheScope).toBe(
        RENDERER_RESOURCE_CACHE_HINT.cacheScope,
      );

      // Additive-only for the operations this package does NOT configure a cacheHint for: tools/list gets
      // the SDK's own conservative default (ttlMs: 0, cacheScope: 'private') on the modern era when the
      // constructor was not given `cacheHints` — same values a legacy-era client already always got
      // (undefined fields it never saw at all), just now visible because this era serializes them.
      const tools = await client.listTools();
      expect((tools as unknown as { ttlMs?: number }).ttlMs).toBe(0);
      expect((tools as unknown as { cacheScope?: string }).cacheScope).toBe("private");
    } finally {
      await close();
    }
  });

  it("tools/list and resources/list carry KOHAKU_MCP_LIST_CACHE_HINT when the caller wires defaultMcpListCacheHints() into the McpServer constructor (apps/sample-mcp/src/setup.ts's pattern)", async () => {
    const buildServer = () => {
      const server = new McpServer(
        { name: "kohaku-cache-hints-list", version: "0.1.0" },
        { cacheHints: defaultMcpListCacheHints() },
      );
      attachKohakuToMcpServer(
        server,
        { compose: makeComposeCtx(), domain, authz, querySource: "sales" },
        {
          rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>",
        },
      );
      return server;
    };
    const { client, close } = await connectModern(buildServer, "cache-hints-list-client");
    try {
      const tools = await client.listTools();
      expect((tools as unknown as { ttlMs?: number }).ttlMs).toBe(KOHAKU_MCP_LIST_CACHE_HINT.ttlMs);
      expect((tools as unknown as { cacheScope?: string }).cacheScope).toBe(
        KOHAKU_MCP_LIST_CACHE_HINT.cacheScope,
      );

      const resources = await client.listResources();
      expect((resources as unknown as { ttlMs?: number }).ttlMs).toBe(KOHAKU_MCP_LIST_CACHE_HINT.ttlMs);
      expect((resources as unknown as { cacheScope?: string }).cacheScope).toBe(
        KOHAKU_MCP_LIST_CACHE_HINT.cacheScope,
      );

      // The per-resource hint on resources/read is unaffected by the operation-level cacheHints configured
      // here (it is a separate CacheableResultMethod, "resources/read", that this constructor call left unset).
      const read = await client.readResource({ uri: RENDERER_RESOURCE_URI });
      expect((read as unknown as { ttlMs?: number }).ttlMs).toBe(RENDERER_RESOURCE_CACHE_HINT.ttlMs);
    } finally {
      await close();
    }
  });

  it("AttachOptions.rendererResourceCacheHint overrides the renderer resource's default cache hint", async () => {
    const buildServer = () => {
      const server = new McpServer({ name: "kohaku-cache-hints-override", version: "0.1.0" });
      attachKohakuToMcpServer(
        server,
        { compose: makeComposeCtx(), domain, authz, querySource: "sales" },
        {
          rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>",
          rendererResourceCacheHint: { ttlMs: 1_000, cacheScope: "public" },
        },
      );
      return server;
    };
    const { client, close } = await connectModern(buildServer, "cache-hints-override-client");
    try {
      const read = await client.readResource({ uri: RENDERER_RESOURCE_URI });
      expect((read as unknown as { ttlMs?: number }).ttlMs).toBe(1_000);
      expect((read as unknown as { cacheScope?: string }).cacheScope).toBe("public");
    } finally {
      await close();
    }
  });
});

describe("MCP 2026-07-28: correlation id stays the per-call request id even when _meta.traceparent is set", () => {
  it("two calls sharing the same traceparent get DIFFERENT correlationIds (each their own JSON-RPC request id), while traceContext.traceparent is identical on both", async () => {
    const correlationIds: (string | undefined)[] = [];
    const traceContexts: Array<{ traceparent: string; tracestate?: string } | undefined> = [];
    const server = new McpServer({ name: "kohaku-correlation-vs-trace", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      {
        compose: makeComposeCtx(),
        domain,
        authz,
        querySource: "sales",
        async onComposed(_spec, trace) {
          correlationIds.push(trace.correlationId);
          traceContexts.push(trace.traceContext);
        },
      },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    const client = new Client({ name: "correlation-vs-trace-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // Intercept the outgoing JSON-RPC request ids the SDK assigns to each tools/call, so this test can
    // assert correlationId equals *this call's own* request id rather than merely "some string".
    const sentRequestIds: string[] = [];
    const rawSend = (clientTransport as unknown as { send: (message: unknown) => Promise<void> }).send.bind(
      clientTransport,
    );
    (clientTransport as unknown as { send: (message: unknown) => Promise<void> }).send = (
      message: unknown,
    ) => {
      const m = message as { method?: string; id?: unknown };
      if (m.method === "tools/call" && "id" in m) sentRequestIds.push(String(m.id));
      return rawSend(message);
    };

    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const first = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
      _meta: { traceparent },
    });
    const second = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
      _meta: { traceparent },
    });

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    expect(sentRequestIds).toHaveLength(2);
    expect(correlationIds).toEqual(sentRequestIds);
    // Same trace, two calls -> different correlation ids (never the shared trace-id).
    expect(correlationIds[0]).not.toBe(correlationIds[1]);
    expect(correlationIds[0]).not.toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(correlationIds[1]).not.toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    // Both still carry the identical traceContext (the OTel span parent), unaffected by correlationId.
    expect(traceContexts[0]).toEqual({ traceparent });
    expect(traceContexts[1]).toEqual({ traceparent });
  });

  it("a malformed traceparent still leaves correlationId as the JSON-RPC request id (fail-open, not an error)", async () => {
    let correlationId: string | undefined;
    const server = new McpServer({ name: "kohaku-traceparent-bad", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      {
        compose: makeComposeCtx(),
        domain,
        authz,
        querySource: "sales",
        async onComposed(_spec, trace) {
          correlationId = trace.correlationId;
        },
      },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    const client = new Client({ name: "traceparent-bad-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
      _meta: { traceparent: "not-a-real-traceparent" },
    });

    expect(result.isError).toBeFalsy();
    expect(correlationId).toBeDefined();
    expect(typeof correlationId).toBe("string");
    expect(correlationId).not.toBe("not-a-real-traceparent");
  });
});

describe("MCP 2026-07-28: _meta.traceparent also drives ComposeOptions.traceContext", () => {
  it("a well-formed traceparent (+ tracestate) becomes ComposeTrace.traceContext unchanged", async () => {
    let traceContext: { traceparent: string; tracestate?: string } | undefined;
    const server = new McpServer({ name: "kohaku-tracecontext", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      {
        compose: makeComposeCtx(),
        domain,
        authz,
        querySource: "sales",
        async onComposed(_spec, trace) {
          traceContext = trace.traceContext;
        },
      },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    const client = new Client({ name: "tracecontext-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
      _meta: { traceparent, tracestate: "vendor=value" },
    });

    expect(result.isError).toBeFalsy();
    expect(traceContext).toEqual({ traceparent, tracestate: "vendor=value" });
  });

  it("a malformed traceparent leaves ComposeOptions.traceContext unset (fail-open, not an error)", async () => {
    let traceContext: { traceparent: string; tracestate?: string } | undefined = { traceparent: "sentinel" };
    const server = new McpServer({ name: "kohaku-tracecontext-bad", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      {
        compose: makeComposeCtx(),
        domain,
        authz,
        querySource: "sales",
        async onComposed(_spec, trace) {
          traceContext = trace.traceContext;
        },
      },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    const client = new Client({ name: "tracecontext-bad-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
      _meta: { traceparent: "not-a-real-traceparent" },
    });

    expect(result.isError).toBeFalsy();
    expect(traceContext).toBeUndefined();
  });
});

describe("fixation self-healing (stale) passes through the TOCTOU guard (arch-1)", () => {
  it("on stale, invalidate receives fixation.catalogFingerprint as the guard (5th arg), and nothing is deleted when the guard mismatches", async () => {
    // The fixation at the moment of the verdict (returned by fixationLookup) and the current fixation "re-approved" afterward have different fingerprints.
    const JUDGED_FP = "fp-judged";
    const CURRENT_FP = "fp-current";
    // A fixed Spec that makes materialize stale: change catalogFingerprint from the current one to enter the revalidation path,
    // and drift the fixed Spec's reference set (refVersions) from the current Intent's resolution result (TREND_REF).
    const staleFixation: FixationRecord = {
      intentHash: "sha256:" + "a".repeat(64),
      canonical: "sales.trend",
      structureHash: "sha256:" + "b".repeat(64),
      pinnedSpec: {
        kohaku: "0.1",
        intent: { canonical: "sales.trend", params: {}, hash: "" },
        dataVersion: "x",
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["c"] },
          {
            id: "c",
            type: "presentChart",
            props: { kind: "line", x: "month", y: "revenue" },
            data: { $ref: TREND_REF },
          },
        ],
        events: [],
        // A key absent from the current resolution URI (TREND_REF) = drift → stale.
        refVersions: { "query://sales/other?x=1": "v1" },
        provenance: { tier: "L0", composedBy: "test", cache: "fixated" },
      } as UISpec,
      fixatedAt: "2026-07-01T00:00:00Z",
      approver: { id: "tester" },
      catalogFingerprint: JUDGED_FP,
    };

    // A guard-compliant storage-backed fixation surface: the current fixation is CURRENT_FP. invalidate deletes only when
    // the guard's fingerprint matches the current fixation (a minimal reproduction of FixationService's conditional-delete semantics).
    let deleted = false;
    let capturedTenant: unknown = "UNSET";
    let capturedGuard: { ifCatalogFingerprint?: string; ifFixatedAt?: string } | undefined | "UNSET" =
      "UNSET";
    const fixations = {
      async invalidate(
        _intentHash: string,
        _reason: "stale",
        options?: {
          detail?: string;
          tenant?: string;
          guard?: { ifCatalogFingerprint?: string; ifFixatedAt?: string };
        },
      ): Promise<void> {
        capturedTenant = options?.tenant;
        capturedGuard = options?.guard;
        if (options?.guard?.ifCatalogFingerprint != null && options.guard.ifCatalogFingerprint !== CURRENT_FP)
          return;
        deleted = true;
      },
    };

    const server = new McpServer({ name: "kohaku-fixation-guard", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      {
        compose: makeComposeCtx(),
        domain,
        authz,
        querySource: "sales",
        fixationLookup: async () => staleFixation,
        fixations,
      },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    const client = new Client({ name: "fixation-guard-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });
    // Since it is stale, the fixation is not delivered and it falls back to normal compose (the result itself is normal).
    expect(result.isError).toBeFalsy();
    // invalidate is fire-and-forget. Drain microtasks / the event loop to wait for the self-healing to fire.
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));

    // options.tenant is always undefined on the MCP surface; options.guard carries the fixatedAt and
    // fingerprint at verdict time (ifFixatedAt is always included; see settleFixation).
    expect(capturedTenant).toBeUndefined();
    expect(capturedGuard).toEqual({
      ifFixatedAt: staleFixation.fixatedAt,
      ifCatalogFingerprint: JUDGED_FP,
    });
    // Since the guard does not match (fp-judged ≠ fp-current), the re-approved fixation is not deleted.
    expect(deleted).toBe(false);
  });
});

describe("kohaku_render_snapshot (self-contained snapshot HTML)", () => {
  // A minimal renderer with the #kohaku-snapshot placeholder (imitating the shape after the single-file build).
  const RENDERER_HTML =
    '<!DOCTYPE html><html><body><div id="root"></div>' +
    '<script id="kohaku-snapshot" type="application/json">null</script></body></html>';

  /** Extracts and parses the embedded JSON from <script id="kohaku-snapshot"> (`<` is already escaped to Unicode → JSON.parse restores it). */
  function readEmbedded(html: string): {
    spec: { provenance: { tier: string } };
    data: Record<string, TabularData>;
  } {
    const open = '<script id="kohaku-snapshot" type="application/json">';
    const start = html.indexOf(open);
    expect(start).toBeGreaterThanOrEqual(0);
    const from = start + open.length;
    // If every `<` is escaped to Unicode, the first raw </script> that appears is the true closing tag (= the end of the embedded region).
    const end = html.indexOf("</script>", from);
    const raw = html.slice(from, end);
    // No raw `<` remains in the embedded region (no variant of the script end tag can be formed = breakout impossible).
    expect(raw.includes("<")).toBe(false);
    return JSON.parse(raw) as ReturnType<typeof readEmbedded>;
  }

  it("embeds the spec and resolved data into the HTML and puts the locator (URL / path) in the tool result text", async () => {
    const written: { fileName: string; html: string }[] = [];
    const server = new McpServer({ name: "kohaku-snap", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      { compose: makeComposeCtx(), domain, authz, querySource: "sales" },
      {
        rendererHtml: RENDERER_HTML,
        snapshotWriter: async (fileName, html) => {
          written.push({ fileName, html });
          return `/abs/snapshots/${fileName}`;
        },
      },
    );
    const client = new Client({ name: "snap-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const result = await client.callTool({
      name: "kohaku_render_snapshot",
      arguments: { question: "Monthly revenue trend" },
    });

    // (b) The tool result text and structuredContent carry the locator (the HTML body is not returned to the model).
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain("/abs/snapshots/");
    // The label is neutral wording (supporting both URL / path), not path-only ("Snapshot:").
    expect(text).toContain("Snapshot:");
    // The structuredContent shape is unchanged ({ path, spec }). path is a locator (local path or public URL).
    const structured = result.structuredContent as { path: string; spec: unknown };
    expect(structured.path).toContain("/abs/snapshots/");
    expect(parseSpec(structured.spec).provenance.tier).toBe("L0");
    // The huge HTML body is not included in the tool result.
    expect(text).not.toContain('<script id="kohaku-snapshot"');

    // (a) The HTML the writer received has the spec and resolved data embedded.
    expect(written).toHaveLength(1);
    const html = written[0]!.html;
    expect(html).not.toContain(">null</script>"); // the placeholder is replaced
    const embedded = readEmbedded(html);
    expect(embedded.spec.provenance.tier).toBe("L0");
    expect(embedded.data[TREND_REF]!.rows).toHaveLength(2);
  });

  it("(c) script end tags in spec/data are escaped to Unicode in every variant (lowercase / uppercase / whitespace-terminated) (breakout prevention)", async () => {
    // A domain that returns data cells mixed with variants of the script end tag. Since HTML's script end-tag detection is
    // case-insensitive and also terminates on whitespace / newline / `/`, escaping only an exact lowercase </script> match would
    // let the uppercase </SCRIPT> and whitespace-terminated </script > pass through. Verify that uniform `<` escaping seals all variants.
    const XSS_CELL = "</script><script>alert(1)</script> </SCRIPT> </script > </script\n>";
    const xssDomain: DomainPort = {
      async listOperations() {
        return [];
      },
      async invoke() {
        return {
          columns: [
            { key: "month", type: "string" },
            { key: "revenue", type: "number" },
          ],
          rows: [{ month: XSS_CELL, revenue: 1 }],
          dataVersion: "sales@seed-1",
        } as TabularData;
      },
    };
    const written: string[] = [];
    const server = new McpServer({ name: "kohaku-snap-xss", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      { compose: makeComposeCtx(), domain: xssDomain, authz, querySource: "sales" },
      {
        rendererHtml: RENDERER_HTML,
        snapshotWriter: async (_fileName, html) => {
          written.push(html);
          return "/abs/snapshots/x.html";
        },
      },
    );
    const client = new Client({ name: "snap-xss-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    await client.callTool({
      name: "kohaku_render_snapshot",
      arguments: { question: "Monthly revenue trend" },
    });

    const html = written[0]!;
    // Extract the embedded region. Since readEmbedded asserts "the region has no raw `<` at all",
    // no variant appears raw (= the script cannot terminate early). In addition, JSON.parse fully restores the cell value.
    const embedded = readEmbedded(html);
    expect(embedded.data[TREND_REF]!.rows[0]!["month"]).toBe(XSS_CELL);
    // Individually confirm too that no variant appears raw in the embedded region (from the opening tag to the true closing </script>).
    const open = '<script id="kohaku-snapshot" type="application/json">';
    const from = html.indexOf(open) + open.length;
    const region = html.slice(from, html.indexOf("</script>", from));
    for (const variant of ["</script>", "</SCRIPT>", "</script >", "</script\n>"]) {
      expect(region.includes(variant)).toBe(false);
    }
    expect(html).toContain("\\u003c"); // the escaped form (`<` as a Unicode escape) exists in the body
  });

  it("the tool itself is not registered when snapshotWriter is not wired", async () => {
    const server = new McpServer({ name: "kohaku-nosnap", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      { compose: makeComposeCtx(), domain, authz, querySource: "sales" },
      { rendererHtml: RENDERER_HTML }, // no snapshotWriter
    );
    const client = new Client({ name: "nosnap-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "kohaku_render_snapshot")).toBeUndefined();
  });

  it("a renderer without the placeholder (unbuilt) fails with guidance to run build:renderer", async () => {
    const server = new McpServer({ name: "kohaku-snap-nobuild", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      { compose: makeComposeCtx(), domain, authz, querySource: "sales" },
      {
        rendererHtml: "<!DOCTYPE html><html><body>unbuilt</body></html>", // no placeholder
        snapshotWriter: async () => "/abs/snapshots/x.html",
      },
    );
    const client = new Client({ name: "snap-nobuild-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const result = await client.callTool({
      name: "kohaku_render_snapshot",
      arguments: { question: "Monthly revenue trend" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toContain("build:renderer");
  });
});

describe("A1: capability issuance for bind variants (MCP surface)", () => {
  const BIND_REF = "query://sales/trend?granularity=month&metric=revenue&region=us";

  /** A compose ctx that returns an L0 fixed Spec with data.bind (region switching). */
  function bindComposeCtx(): ComposeContext {
    const base = makeComposeCtx();
    return {
      ...base,
      policy: {
        fixedSpecs: {
          async lookup() {
            return (intentArg): UISpec => ({
              kohaku: "0.2",
              intent: intentArg,
              dataVersion: "x",
              state: { region: "us" },
              components: [
                { id: "root", type: "layout.stack", props: {}, children: ["c"] },
                {
                  id: "c",
                  type: "presentChart",
                  props: { kind: "line", x: "month", y: "revenue" },
                  data: {
                    $ref: BIND_REF,
                    bind: { region: { $state: "region", values: ["us", "eu", "jp"] } },
                  },
                },
              ],
              events: [],
              provenance: { tier: "L0", composedBy: "test", cache: "miss" },
            });
          },
        },
      },
    };
  }

  it("enumerates the full data.bind values cross-product in the read scope, and switch-target variants can also resolve", async () => {
    const server = new McpServer({ name: "kohaku-bind", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      { compose: bindComposeCtx(), domain, authz, querySource: "sales" },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    const client = new Client({ name: "bind-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const composeResult = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Trend with region switch" },
    });
    const capability = capabilityOf(composeResult);
    // Same rule as the REST surface (issueCapabilityForSpec) (SPEC §5 A1): every variant in values, including the
    // initial variant ($ref), is included in the read scope.
    for (const region of ["us", "eu", "jp"]) {
      expect(capability).toContain(`query://sales/trend?granularity=month&metric=revenue&region=${region}`);
    }

    // Data resolution of the switch-target variant is not capability-denied
    // (before the fix, only the raw $ref was issued, and switching to anything other than the initial value was rejected on the MCP surface only).
    const resolved = await client.callTool({
      name: "kohaku_resolve_binding",
      arguments: {
        ref: "query://sales/trend?granularity=month&metric=revenue&region=eu",
        capability,
      },
    });
    expect(resolved.isError).toBeFalsy();
    expect((resolved.structuredContent as { data: TabularData }).data.rows).toHaveLength(2);
  });
});

/** A compose ctx that returns an L0 fixed Spec with a region-switching bind (us/eu/jp). Used for the initial-data co-embedding's multi-variant verification. */
const BIND_REF_US = "query://sales/trend?granularity=month&metric=revenue&region=us";
function bindComposeCtxA(): ComposeContext {
  const base = makeComposeCtx();
  return {
    ...base,
    policy: {
      fixedSpecs: {
        async lookup() {
          return (intentArg): UISpec => ({
            kohaku: "0.2",
            intent: intentArg,
            dataVersion: "x",
            state: { region: "us" },
            components: [
              { id: "root", type: "layout.stack", props: {}, children: ["c"] },
              {
                id: "c",
                type: "presentChart",
                props: { kind: "line", x: "month", y: "revenue" },
                data: {
                  $ref: BIND_REF_US,
                  bind: { region: { $state: "region", values: ["us", "eu", "jp"] } },
                },
              },
            ],
            events: [],
            provenance: { tier: "L0", composedBy: "test", cache: "miss" },
          });
        },
      },
    },
  };
}

/** A compose ctx that returns an L0 fixed Spec of 2 components (each with an independent initial $ref). Used for Q1's budget-spillover verification. */
const REF_COMP1 = "query://sales/trend?granularity=month&metric=revenue";
const REF_COMP2 = "query://sales/trend?granularity=month&metric=units";
function twoComponentComposeCtx(): ComposeContext {
  const base = makeComposeCtx();
  return {
    ...base,
    policy: {
      fixedSpecs: {
        async lookup() {
          return (intentArg): UISpec => ({
            kohaku: "0.1",
            intent: intentArg,
            dataVersion: "x",
            components: [
              { id: "root", type: "layout.stack", props: {}, children: ["c1", "c2"] },
              {
                id: "c1",
                type: "presentChart",
                props: { kind: "line", x: "month", y: "revenue" },
                data: { $ref: REF_COMP1 },
              },
              {
                id: "c2",
                type: "presentChart",
                props: { kind: "line", x: "month", y: "units" },
                data: { $ref: REF_COMP2 },
              },
            ],
            events: [],
            provenance: { tier: "L0", composedBy: "test", cache: "miss" },
          });
        },
      },
    },
  };
}

describe("task A: co-embedding initial data in tool-result _meta", () => {
  it("the meta key constants match the renderer-side literals (host ⇄ renderer drift detection)", () => {
    // First, the constant values must be the literal strings from the spec (defined in packages/host-mcp-apps/src/meta.ts).
    expect(INITIAL_DATA_META_KEY).toBe("kohaku/initialData");
    expect(CAPABILITY_META_KEY).toBe("kohaku/capability");
    // The renderer (apps/sample-mcp/renderer/host-integration.ts) holds both keys as literals without importing
    // host-mcp-apps, to respect the dependency direction and avoid single-file bundle bloat. Detect drift from the
    // definition source by reading the actual source (checking only the constant value would read not a single
    // character of the renderer-side literal, letting divergence pass green).
    const rendererPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "apps",
      "sample-mcp",
      "renderer",
      "host-integration.ts",
    );
    const rendererSrc = readFileSync(rendererPath, "utf8");
    expect(rendererSrc).toContain(`"${INITIAL_DATA_META_KEY}"`);
    expect(rendererSrc).toContain(`"${CAPABILITY_META_KEY}"`);
  });

  it("the compose result's _meta co-embeds pre-resolved initial data (resolved down to rows)", async () => {
    const server = new McpServer({ name: "kohaku-initdata", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      { compose: makeComposeCtx(), domain, authz, querySource: "sales" },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    const client = new Client({ name: "initdata-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });
    // initialData is co-embedded in _meta, resolved down to rows (a path that reaches only the widget, not through the model).
    const initial = result._meta?.[INITIAL_DATA_META_KEY] as Record<string, TabularData> | undefined;
    expect(initial).toBeDefined();
    expect(initial![TREND_REF]!.rows).toHaveLength(2);
    // The existing UI declaration meta (resourceUri) coexists too.
    expect(result._meta?.[RESOURCE_URI_META_KEY]).toBe(RENDERER_RESOURCE_URI);
  });

  it("on budget overflow it co-embeds partially, prioritizing each component's initial variant ($ref)", async () => {
    // Returns data large enough that each variant occupies more than half the budget (100,000 chars) → only the initial variant fits.
    const bigCell = "x".repeat(70_000);
    const bigDomain: DomainPort = {
      async listOperations() {
        return [];
      },
      async invoke() {
        return {
          columns: [{ key: "month", type: "string" }],
          rows: [{ month: bigCell }],
          dataVersion: "sales@seed-1",
        } as TabularData;
      },
    };
    const server = new McpServer({ name: "kohaku-budget", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      { compose: bindComposeCtxA(), domain: bigDomain, authz, querySource: "sales" },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    const client = new Client({ name: "budget-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Trend with region switch" },
    });
    const initial = result._meta?.[INITIAL_DATA_META_KEY] as Record<string, TabularData>;
    // Of the 3 variants (us/eu/jp), only the initial variant (us) fits within the budget = partial embedding.
    expect(Object.keys(initial)).toEqual([BIND_REF_US]);
  });

  it("per-ref fail-open: a single ref's resolution failure is skipped and reported to onError, while compose stays successful", async () => {
    const seen: { endpoint: string; error: unknown }[] = [];
    // A domain where only region=eu resolution fails (us/jp succeed).
    const failDomain: DomainPort = {
      async listOperations() {
        return [];
      },
      async invoke(_op, args) {
        if ((args as { region?: string }).region === "eu") {
          throw new Error("eu resolution failed (test)");
        }
        return DATA;
      },
    };
    const server = new McpServer({ name: "kohaku-failopen-init", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      {
        compose: bindComposeCtxA(),
        domain: failDomain,
        authz,
        querySource: "sales",
        onError: (info) => {
          seen.push({ endpoint: info.endpoint, error: info.error });
        },
      },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    const client = new Client({ name: "failopen-init-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Trend with region switch" },
    });
    // compose itself succeeds (returns a Spec, not isError).
    expect(result.isError).toBeFalsy();
    const initial = result._meta?.[INITIAL_DATA_META_KEY] as Record<string, TabularData>;
    // Only eu is missing; us / jp are co-embedded (fail-open does not drag down the other refs).
    const keys = Object.keys(initial);
    expect(keys).toContain(BIND_REF_US);
    expect(keys).toContain("query://sales/trend?granularity=month&metric=revenue&region=jp");
    expect(keys).not.toContain("query://sales/trend?granularity=month&metric=revenue&region=eu");
    // The failure is reported to the observation hook (endpoint = compose.initialData).
    expect(seen).toHaveLength(1);
    expect(seen[0]!.endpoint).toBe("compose.initialData");
    expect(seen[0]!.error).toBeInstanceOf(Error);
  });

  it("per-ref timeout: even with a forever-pending ref the tool response still returns, that ref is not co-embedded while the others are", async () => {
    // Only region=eu resolution stays pending forever (us/jp resolve immediately). Without a per-ref timeout, the entire
    // tool-result stops returning. Inject a short timeout to verify this deterministically.
    const seen: { endpoint: string; error: unknown }[] = [];
    const hangDomain: DomainPort = {
      async listOperations() {
        return [];
      },
      async invoke(_op, args) {
        if ((args as { region?: string }).region === "eu") {
          return new Promise<TabularData>(() => {}); // pending forever
        }
        return DATA;
      },
    };
    __setPreresolveTimeoutMsForTest(30);
    try {
      const server = new McpServer({ name: "kohaku-preresolve-timeout", version: "0.1.0" });
      attachKohakuToMcpServer(
        server,
        {
          compose: bindComposeCtxA(),
          domain: hangDomain,
          authz,
          querySource: "sales",
          onError: (info) => {
            seen.push({ endpoint: info.endpoint, error: info.error });
          },
        },
        { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
      );
      const client = new Client({ name: "preresolve-timeout-client", version: "0.0.1" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(st), client.connect(ct)]);

      // A response returns even with the pending eu (without a timeout it would hang here).
      const result = await client.callTool({
        name: "kohaku_compose",
        arguments: { question: "Trend with region switch" },
      });
      expect(result.isError).toBeFalsy();
      const initial = result._meta?.[INITIAL_DATA_META_KEY] as Record<string, TabularData>;
      const keys = Object.keys(initial);
      // Only the timed-out eu is missing; us / jp are co-embedded (treated the same as per-ref fail-open).
      expect(keys).toContain(BIND_REF_US);
      expect(keys).toContain("query://sales/trend?granularity=month&metric=revenue&region=jp");
      expect(keys).not.toContain("query://sales/trend?granularity=month&metric=revenue&region=eu");
      // The timeout is reported to the observation hook (endpoint = compose.initialData).
      expect(seen).toHaveLength(1);
      expect(seen[0]!.endpoint).toBe("compose.initialData");
      expect(seen[0]!.error).toBeInstanceOf(Error);
    } finally {
      __setPreresolveTimeoutMsForTest(null); // do not affect other tests
    }
  });

  it("Q1: when the first component's large initial ref exhausts the budget, subsequent components' initial variants are also not co-embedded (pinning current behavior)", async () => {
    // Each component's initial ref occupies 70% of the budget (100,000 chars) → the first fits and the rest are cut off by break.
    // Regression guard for the current spec (server.ts's break) that cuts off all subsequent refs once over budget. No behavior change.
    const bigCell = "x".repeat(70_000);
    const bigDomain: DomainPort = {
      async listOperations() {
        return [];
      },
      async invoke() {
        return {
          columns: [{ key: "month", type: "string" }],
          rows: [{ month: bigCell }],
          dataVersion: "sales@seed-1",
        } as TabularData;
      },
    };
    const server = new McpServer({ name: "kohaku-budget-multi", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      { compose: twoComponentComposeCtx(), domain: bigDomain, authz, querySource: "sales" },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    const client = new Client({ name: "budget-multi-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "2 components" },
    });
    const initial = result._meta?.[INITIAL_DATA_META_KEY] as Record<string, TabularData>;
    // Only the first component's initial ref is co-embedded; the subsequent component's initial ref is missing due to the budget cut-off.
    expect(Object.keys(initial)).toEqual([REF_COMP1]);
  });

  it("resolves refs concurrently: the in-flight worker count peaks above 1 and stays within the bounded pool", async () => {
    // A compose ctx with 8 independent components, each with its own initial $ref. If preresolveInitialData
    // resolved them serially (the old behavior), inFlight would never exceed 1; with bounded concurrency
    // (PRERESOLVE_CONCURRENCY workers) several run at once. Assert on the observed in-flight counter itself
    // (not on wall-clock elapsed time, which is flaky under CI/load) — bounded to [2, 8]: above 1 proves it is
    // not serial, and at most 8 proves the pool is bounded rather than unbounded.
    const componentCount = 8;
    const refFor = (i: number): string => `query://sales/trend?granularity=month&metric=revenue&idx=${i}`;
    let inFlight = 0;
    let maxInFlight = 0;
    const slowDomain: DomainPort = {
      async listOperations() {
        return [];
      },
      async invoke() {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // A short real delay only to hold the concurrency window open long enough for sibling workers to
        // start (synchronization, not a timing assertion — the assertion below is on maxInFlight, not elapsed time).
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight--;
        return DATA;
      },
    };
    const base = makeComposeCtx();
    const composeCtx: ComposeContext = {
      ...base,
      policy: {
        fixedSpecs: {
          async lookup() {
            return (intentArg): UISpec => ({
              kohaku: "0.1",
              intent: intentArg,
              dataVersion: "x",
              components: [
                {
                  id: "root",
                  type: "layout.stack",
                  props: {},
                  children: Array.from({ length: componentCount }, (_, i) => `c${i}`),
                },
                ...Array.from({ length: componentCount }, (_, i) => ({
                  id: `c${i}`,
                  type: "presentChart",
                  props: { kind: "line" as const, x: "month", y: "revenue" },
                  data: { $ref: refFor(i) },
                })),
              ],
              events: [],
              provenance: { tier: "L0" as const, composedBy: "test", cache: "miss" as const },
            });
          },
        },
      },
    };
    const server = new McpServer({ name: "kohaku-concurrency", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      { compose: composeCtx, domain: slowDomain, authz, querySource: "sales" },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    const client = new Client({ name: "concurrency-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "8 components" },
    });
    expect(result.isError).toBeFalsy();
    const initial = result._meta?.[INITIAL_DATA_META_KEY] as Record<string, TabularData>;
    // All 8 refs are small enough to fit the budget and are resolved (none hang or fail).
    expect(Object.keys(initial)).toHaveLength(componentCount);
    // Bounded concurrency: more than one worker ran at once (not serial), but no more than the pool size.
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });

  it("the total deadline stops waiting for never-resolving refs and still returns the tool result", async () => {
    // Only region=eu resolution stays pending forever; us/jp resolve immediately. A short total deadline (well
    // below the per-ref timeout default of 2000ms) must cut the wait short so the tool call still returns.
    const seen: { endpoint: string; error: unknown }[] = [];
    const mostlyHangDomain: DomainPort = {
      async listOperations() {
        return [];
      },
      async invoke(_op, args) {
        if ((args as { region?: string }).region === "eu") {
          return new Promise<TabularData>(() => {}); // pending forever
        }
        return DATA;
      },
    };
    __setPreresolveTotalTimeoutMsForTest(50);
    try {
      const server = new McpServer({ name: "kohaku-total-deadline", version: "0.1.0" });
      attachKohakuToMcpServer(
        server,
        {
          compose: bindComposeCtxA(),
          domain: mostlyHangDomain,
          authz,
          querySource: "sales",
          onError: (info) => {
            seen.push({ endpoint: info.endpoint, error: info.error });
          },
        },
        { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
      );
      const client = new Client({ name: "total-deadline-client", version: "0.0.1" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(st), client.connect(ct)]);

      // A response returns promptly even though eu never resolves (without the total deadline this would hang
      // until the process is torn down, since the per-ref timeout alone is 2000ms and Promise.race there never
      // settles for a promise that never rejects either).
      const result = await client.callTool({
        name: "kohaku_compose",
        arguments: { question: "Trend with region switch" },
      });
      expect(result.isError).toBeFalsy();
      const initial = result._meta?.[INITIAL_DATA_META_KEY] as Record<string, TabularData>;
      const keys = Object.keys(initial);
      expect(keys).toContain(BIND_REF_US);
      expect(keys).toContain("query://sales/trend?granularity=month&metric=revenue&region=jp");
      expect(keys).not.toContain("query://sales/trend?granularity=month&metric=revenue&region=eu");
    } finally {
      __setPreresolveTotalTimeoutMsForTest(null); // do not affect other tests
    }
  });
});

describe("task C: the MCP surface's write path (kohaku_action)", () => {
  /** A compose ctx that returns an L0 fixed Spec with presentForm (action=annotate) + an action.invoke event. */
  function writeComposeCtx(): ComposeContext {
    const base = makeComposeCtx();
    return {
      ...base,
      policy: {
        fixedSpecs: {
          async lookup() {
            return (intentArg): UISpec => ({
              kohaku: "0.1",
              intent: intentArg,
              dataVersion: "x",
              components: [
                { id: "root", type: "layout.stack", props: {}, children: ["f"] },
                { id: "f", type: "presentForm", props: { action: "annotate" } },
              ],
              events: [{ on: "f.submit", emit: "action.invoke", payload: {} }],
              provenance: { tier: "L0", composedBy: "test", cache: "miss" },
            });
          },
        },
      },
    };
  }

  /** A domain that handles annotate (a write). Advances the data version. */
  const writeDomain: DomainPort = {
    async listOperations() {
      return [{ name: "annotate", description: "sales annotate (write)" }];
    },
    async invoke(op) {
      if (op === "annotate") return { ok: true, dataVersion: "sales@seed-2" };
      throw new Error("unknown op");
    },
  };

  /** A domain that does not list annotate among its operations (to test write-scope dropping). Also
   * serves "trend" (DATA) so a $ref alongside the dropped write scope pre-resolves without a spurious
   * onError entry unrelated to the write-scope drop being tested. */
  const writeDomainWithoutAnnotate: DomainPort = {
    async listOperations() {
      return [];
    },
    async invoke(op) {
      if (op === "annotate") return { ok: true, dataVersion: "sales@seed-2" };
      if (op === "trend") return DATA;
      throw new Error("unknown op");
    },
  };

  /** A side-effect declaration of the same shape as the REST surface's salesActionEffects (annotate → invalidate payload.refs with the new version). */
  const actionEffects = async (
    action: string,
    payload: Record<string, unknown>,
    result: unknown,
  ): Promise<{ invalidates?: string[]; refVersions?: Record<string, string> }> => {
    if (action !== "annotate") return {};
    const refs = Array.isArray(payload["refs"])
      ? (payload["refs"] as unknown[]).filter((r): r is string => typeof r === "string")
      : [];
    const dataVersion = (result as { dataVersion?: unknown }).dataVersion;
    if (refs.length === 0 || typeof dataVersion !== "string") return { invalidates: refs };
    return { invalidates: refs, refVersions: Object.fromEntries(refs.map((r) => [r, dataVersion])) };
  };

  async function connect(deps?: { actionEffects?: typeof actionEffects }): Promise<Client> {
    const server = new McpServer({ name: "kohaku-write", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      {
        compose: writeComposeCtx(),
        domain: writeDomain,
        authz,
        querySource: "sales",
        ...(deps?.actionEffects != null ? { actionEffects: deps.actionEffects } : {}),
      },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    const client = new Client({ name: "write-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    return client;
  }

  it("kohaku_action is registered as app-only (visibility ['app'] / no resourceUri)", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const action = tools.find((t) => t.name === "kohaku_action")!;
    expect(action).toBeDefined();
    expect(action._meta?.[VISIBILITY_META_KEY]).toEqual(["app"]);
    expect(uiMeta(action._meta)?.visibility).toEqual(["app"]);
    // A write does not open a view, so it has no resourceUri (same as resolve_binding).
    expect(action._meta?.[RESOURCE_URI_META_KEY]).toBeUndefined();
    expect(uiMeta(action._meta)?.resourceUri).toBeUndefined();
    await client.close();
  });

  it("with a compose-issued capability (write scope), kohaku_action's verify passes and the side effect is applied", async () => {
    const client = await connect({ actionEffects });
    // Obtain a capability that includes the write scope (annotate) via compose.
    const composed = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Annotation form" },
    });
    const capability = capabilityOf(composed);
    // The issued capability includes the write action name (symmetric with the REST surface's issueCapabilityForSpec).
    expect(capability).toContain("annotate");

    const result = await client.callTool({
      name: "kohaku_action",
      arguments: { action: "annotate", payload: { note: "review", refs: [TREND_REF] }, capability },
    });
    expect(result.isError).toBeFalsy();
    // structuredContent is { result, invalidates?, refVersions? } (the shape parseActionResult can read).
    const structured = result.structuredContent as {
      result: { ok: boolean; dataVersion: string };
      invalidates?: string[];
      refVersions?: Record<string, string>;
    };
    expect(structured.result.ok).toBe(true);
    expect(structured.invalidates).toEqual([TREND_REF]);
    expect(structured.refVersions?.[TREND_REF]).toBe("sales@seed-2");
    await client.close();
  });

  it("an action not listed by DomainPort.listOperations gets no write scope, and kohaku_action itself rejects it as unknown (isError), and onError is notified", async () => {
    // Distinct from writeComposeCtx(): also declares a $ref, so dropping the write scope still leaves a
    // non-empty capability token — the shared `authz` fake here matches by ref-prefix rather than exact
    // kind+ref, so an entirely empty scope list would make its prefix check ("".startsWith trivially matching
    // everything) spuriously grant access, which is a quirk of this test double, not of the production
    // capability-filtering logic under test.
    function writeComposeCtxWithRef(): ComposeContext {
      const base = makeComposeCtx();
      return {
        ...base,
        policy: {
          fixedSpecs: {
            async lookup() {
              return (intentArg): UISpec => ({
                kohaku: "0.1",
                intent: intentArg,
                dataVersion: "x",
                components: [
                  { id: "root", type: "layout.stack", props: {}, children: ["f", "t"] },
                  { id: "f", type: "presentForm", props: { action: "annotate" } },
                  { id: "t", type: "presentTable", props: {}, data: { $ref: TREND_REF } },
                ],
                events: [{ on: "f.submit", emit: "action.invoke", payload: {} }],
                provenance: { tier: "L0", composedBy: "test", cache: "miss" },
              });
            },
          },
        },
      };
    }

    const seen: { endpoint: string; error: unknown }[] = [];
    const server = new McpServer({ name: "kohaku-write-unlisted", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      {
        compose: writeComposeCtxWithRef(),
        domain: writeDomainWithoutAnnotate,
        authz,
        querySource: "sales",
        actionEffects,
        onError: (info) => {
          seen.push({ endpoint: info.endpoint, error: info.error });
        },
      },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    const client = new Client({ name: "write-unlisted-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const composed = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Annotation form" },
    });
    const capability = capabilityOf(composed);
    // annotate is not among writeDomainWithoutAnnotate's listOperations(), so the write scope was dropped.
    expect(capability).not.toContain("annotate");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.endpoint).toBe("compose.capability");
    expect(seen[0]!.error).toBeInstanceOf(Error);
    expect((seen[0]!.error as Error).message).toContain("annotate");

    const result = await client.callTool({
      name: "kohaku_action",
      arguments: { action: "annotate", payload: { note: "review", refs: [TREND_REF] }, capability },
    });
    expect(result.isError).toBe(true);
    // registerActionTool's own allowedActions check (the same DomainPort.listOperations() source that dropped
    // the write scope above) rejects the action before capability verification is even attempted.
    expect((result.content as { text: string }[])[0]!.text).toContain("unknown action");
    await client.close();
  });

  it("a capability without the write scope is verify-denied → toolError (not an RPC exception)", async () => {
    const client = await connect({ actionEffects });
    // A read-only capability (does not include annotate's write scope).
    const result = await client.callTool({
      name: "kohaku_action",
      arguments: {
        action: "annotate",
        payload: {},
        capability: "cap:query://sales/other",
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toContain("capability denied");
    await client.close();
  });

  it("action-effects fail-open: even when actionEffects throws, the write succeeds ({result} only) and the failure goes to the observability hook", async () => {
    // domain.invoke (the write) has already succeeded. If a side-effect declaration (actionEffects) failure were turned into
    // safeTool's toolError, the model/client would resend and a non-idempotent write could be duplicated. Report the effects failure to observation and respond as success.
    const seen: { endpoint: string; error: unknown }[] = [];
    const server = new McpServer({ name: "kohaku-write-effects-fail", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      {
        compose: writeComposeCtx(),
        domain: writeDomain,
        authz,
        querySource: "sales",
        actionEffects: async () => {
          throw new Error("effects computation failed (test)");
        },
        onError: (info) => {
          seen.push({ endpoint: info.endpoint, error: info.error });
        },
      },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    const client = new Client({ name: "write-effects-fail-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const composed = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Annotation form" },
    });
    const capability = capabilityOf(composed);

    const result = await client.callTool({
      name: "kohaku_action",
      arguments: { action: "annotate", payload: { note: "review", refs: [TREND_REF] }, capability },
    });
    // The write is treated as committed: returns { result } only (the backward-compatible shape), not isError.
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect((structured["result"] as { ok: boolean }).ok).toBe(true);
    expect(structured).not.toHaveProperty("invalidates");
    expect(structured).not.toHaveProperty("refVersions");
    // The effects failure is reported to the observation hook (endpoint = kohaku_action.effects, distinguished from a write failure).
    expect(seen).toHaveLength(1);
    expect(seen[0]!.endpoint).toBe("kohaku_action.effects");
    expect(seen[0]!.error).toBeInstanceOf(Error);
    await client.close();
  });

  it("allowedActions() fail-closes on the first listOperations() rejection, then recovers on the next compose", async () => {
    // host-core's createAllowedActions memoizes listOperations() per attachKohakuToMcpServer call, but discards
    // the cached promise on rejection so the next call retries. The first compose must therefore drop the write
    // scope (fail-closed = empty allowed set) and notify onError, while a second compose against the same
    // server recovers the real operation list and grants the write scope. (In between, kohaku_action's own
    // allowedActions check also retries listOperations() — see the deniedAction call below — so the "second"
    // real DomainPort call may actually happen there rather than at the second compose; either way `calls`
    // reaches exactly 2 by the time the second compose's assertion runs.)
    //
    // Also declares a $ref (distinct from writeComposeCtx()) so dropping the write scope still leaves a
    // non-empty capability token — with a truly empty scope list, this suite's `authz` fake's prefix check
    // ("".startsWith trivially matching everything) would spuriously grant access regardless of scope (see
    // the "an action not listed by DomainPort.listOperations" test above for the same caveat).
    function composeCtxWithRef(): ComposeContext {
      const base = makeComposeCtx();
      return {
        ...base,
        policy: {
          fixedSpecs: {
            async lookup() {
              return (intentArg): UISpec => ({
                kohaku: "0.1",
                intent: intentArg,
                dataVersion: "x",
                components: [
                  { id: "root", type: "layout.stack", props: {}, children: ["f", "t"] },
                  { id: "f", type: "presentForm", props: { action: "annotate" } },
                  { id: "t", type: "presentTable", props: {}, data: { $ref: TREND_REF } },
                ],
                events: [{ on: "f.submit", emit: "action.invoke", payload: {} }],
                provenance: { tier: "L0", composedBy: "test", cache: "miss" },
              });
            },
          },
        },
      };
    }

    let calls = 0;
    const flakyDomain: DomainPort = {
      async listOperations() {
        calls++;
        if (calls === 1) throw new Error("listOperations unavailable (transient)");
        return [{ name: "annotate", description: "sales annotate (write)" }];
      },
      async invoke(op) {
        if (op === "annotate") return { ok: true, dataVersion: "sales@seed-2" };
        if (op === "trend") return DATA;
        throw new Error("unknown op");
      },
    };
    const seen: { endpoint: string; error: unknown }[] = [];
    const server = new McpServer({ name: "kohaku-flaky-list-ops", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      {
        compose: composeCtxWithRef(),
        domain: flakyDomain,
        authz,
        querySource: "sales",
        onError: (info) => {
          seen.push({ endpoint: info.endpoint, error: info.error });
        },
      },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    const client = new Client({ name: "flaky-list-ops-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    // First compose: listOperations() rejects -> fail-closed (empty allowed set), no write scope granted.
    // Two failures land on the observability hook for this single compose: the listOperations() rejection
    // itself, and the consequent write-scope drop (issueCapabilityForSpec's onDroppedAction, since the
    // fail-closed allowed set is empty) — both reported at endpoint "compose.capability".
    const first = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Annotation form" },
    });
    const firstCapability = capabilityOf(first);
    expect(calls).toBe(1);
    expect(firstCapability).not.toContain("annotate");
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.every((s) => s.endpoint === "compose.capability")).toBe(true);
    expect(seen.some((s) => (s.error as Error).message.includes("listOperations unavailable"))).toBe(true);

    const deniedAction = await client.callTool({
      name: "kohaku_action",
      arguments: { action: "annotate", payload: { note: "review" }, capability: firstCapability },
    });
    expect(deniedAction.isError).toBe(true);

    // Second compose (same server / same allowedActions() closure): the cached rejection was discarded, so
    // listOperations() is retried and now succeeds, granting the write scope.
    const second = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Annotation form" },
    });
    const secondCapability = capabilityOf(second);
    expect(calls).toBe(2);
    expect(secondCapability).toContain("annotate");

    const allowedAction = await client.callTool({
      name: "kohaku_action",
      arguments: { action: "annotate", payload: { note: "review" }, capability: secondCapability },
    });
    expect(allowedAction.isError).toBeFalsy();
    await client.close();
  });

  it("a payload exceeding the 64KB canonical-JSON cap is rejected (isError), before capability verification", async () => {
    const client = await connect({ actionEffects });
    const composed = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Annotation form" },
    });
    const capability = capabilityOf(composed);
    // A single oversized field is enough to push the canonical-JSON byte size (which also re-quotes/escapes
    // the string) past MAX_ACTION_PAYLOAD_BYTES (64 * 1024).
    const oversizedNote = "x".repeat(70_000);
    const result = await client.callTool({
      name: "kohaku_action",
      arguments: { action: "annotate", payload: { note: oversizedNote }, capability },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toContain("exceeds the maximum size");
    await client.close();
  });

  it("when listOperations() always rejects, kohaku_action denies every action (isError: unknown action) and onError is notified", async () => {
    const seen: { endpoint: string; error: unknown }[] = [];
    const failingDomain: DomainPort = {
      async listOperations() {
        throw new Error("domain permanently unavailable (test)");
      },
      async invoke(op) {
        if (op === "annotate") return { ok: true, dataVersion: "sales@seed-2" };
        throw new Error("unknown op");
      },
    };
    const server = new McpServer({ name: "kohaku-write-listops-down", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      {
        compose: writeComposeCtx(),
        domain: failingDomain,
        authz,
        querySource: "sales",
        onError: (info) => {
          seen.push({ endpoint: info.endpoint, error: info.error });
        },
      },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    const client = new Client({ name: "write-listops-down-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    // A capability that would, in isolation, verify for a write to "annotate" (the fake `authz` here matches
    // by ref-prefix) — proving the denial below comes from the allowedActions check, not from verify.
    const result = await client.callTool({
      name: "kohaku_action",
      arguments: { action: "annotate", payload: {}, capability: "cap:annotate" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toContain("unknown action");
    expect(seen.some((s) => s.endpoint === "kohaku_action.allowedActions")).toBe(true);
    expect(seen.some((s) => (s.error as Error).message.includes("domain permanently unavailable"))).toBe(
      true,
    );
    await client.close();
  });
});

describe("mcp-ui legacy UIResource attachment (legacyUiResource opt-in)", () => {
  // A minimal renderer with the #kohaku-snapshot placeholder (imitating the shape after the single-file build).
  const RENDERER_HTML =
    '<!DOCTYPE html><html><body><div id="root"></div>' +
    '<script id="kohaku-snapshot" type="application/json">null</script></body></html>';

  async function callCompose(
    options: Parameters<typeof attachKohakuToMcpServer>[2],
    onError?: (info: { endpoint: string; error: unknown }) => void,
  ) {
    const server = new McpServer({ name: "kohaku-legacy", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      {
        compose: makeComposeCtx(),
        domain,
        authz,
        querySource: "sales",
        ...(onError != null ? { onError } : {}),
      },
      options,
    );
    const client = new Client({ name: "legacy-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });
    await client.close();
    return result;
  }

  it("when enabled, content[1] attaches a ui:// UIResource (self-contained snapshot)", async () => {
    const result = await callCompose({ rendererHtml: RENDERER_HTML, legacyUiResource: true });
    const content = result.content as {
      type: string;
      text?: string;
      resource?: { uri: string; mimeType: string; text: string };
    }[];
    // content[0] is the unchanged text fallback (MCPAPP-FBK-001).
    expect(content[0]!.type).toBe("text");
    expect(content[0]!.text).toContain("Chart");
    // content[1] is the mcp-ui legacy-host detection shape (type: resource + ui:// prefix + text/html).
    expect(content).toHaveLength(2);
    const resource = content[1]!.resource!;
    expect(content[1]!.type).toBe("resource");
    const spec = parseSpec((result.structuredContent as { spec: unknown }).spec);
    expect(resource.uri).toBe(`ui://kohaku/view/${spec.intent.hash}`);
    expect(resource.mimeType).toBe("text/html");
    // The body is a self-contained snapshot (the placeholder is replaced with {spec, data} = it runs in static-render mode).
    // Escaping `<` (breakout prevention) is the province of injectSnapshot, which snapshotHtmlFor shares, and is
    // guaranteed by the dedicated XSS test (all variants of the script end tag).
    expect(resource.text).toContain('<script id="kohaku-snapshot"');
    expect(resource.text).not.toContain(">null</script>");
    // The embedding contains resolved data (down to rows) = opening it on a legacy host makes static rendering work.
    expect(resource.text).toContain('"rows"');
  });

  it("by default (unspecified) content is text-only (fully backward compatible)", async () => {
    const result = await callCompose({ rendererHtml: RENDERER_HTML });
    expect(result.content as unknown[]).toHaveLength(1);
  });

  it("snapshot assembly failure (no placeholder) is fail-open: no attachment + observability hook notification", async () => {
    const seen: { endpoint: string; error: unknown }[] = [];
    const result = await callCompose(
      // An unbuilt renderer with no placeholder → injectSnapshot throws
      { rendererHtml: "<!DOCTYPE html><html><body>unbuilt</body></html>", legacyUiResource: true },
      (info) => {
        seen.push(info);
      },
    );
    // A normal response without the co-emission (compose itself remains successful).
    expect(result.isError).toBeFalsy();
    expect(result.content as unknown[]).toHaveLength(1);
    expect(seen.some((s) => s.endpoint === "compose.legacyUiResource")).toBe(true);
  });
});

// Symmetric view audit via recorder, cancellation propagation, and bounded snapshot resolution shared
// with initial-data preresolution.

describe("symmetric view audit via ViewRecorder (host-mcp-apps)", () => {
  /** A compose ctx with no fixedSpecs and an LLM that always fails schema validation, so every compose
   * exhausts L1 into the deterministic fallback (provenance.fallback.kind = "generation") — exercising the
   * fallback-recording path without needing a capability-negotiation downgrade. FakeLlm does not advance its
   * script index on a validation failure (a failed response is "not consumed"), so a single scripted `bad`
   * object suffices to fail every attempt across both tool calls in the test below. */
  function fallbackComposeCtx(): ComposeContext {
    const base = makeComposeCtx();
    return { ...base, llm: new FakeLlm({ objects: [{ components: [], events: [] }] }), policy: {} };
  }

  it("kohaku_compose records composed + fallback; kohaku_event additionally records interacted before recomposing", async () => {
    const composedCalls: { surface: string }[] = [];
    const interactedCalls: {
      intentHash: string;
      componentId: string;
      on: string;
      payload: JsonObject;
      surface: string;
    }[] = [];
    const fallbackCalls: { reason: string; kind: string; surface: string }[] = [];
    const recorder: ViewRecorder = {
      async composed(args) {
        composedCalls.push({ surface: args.surface });
      },
      async interacted(args) {
        interactedCalls.push({
          intentHash: args.intentHash,
          componentId: args.componentId,
          on: args.on,
          payload: args.payload,
          surface: args.surface,
        });
      },
      async fallback(args) {
        fallbackCalls.push({ reason: args.reason, kind: args.kind, surface: args.surface });
      },
    };

    const server = new McpServer({ name: "kohaku-recorder", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      { compose: fallbackComposeCtx(), domain, authz, querySource: "sales", recorder },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    const client = new Client({ name: "recorder-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const composed = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });
    expect(composed.isError).toBeFalsy();
    expect(composedCalls).toEqual([{ surface: "mcp-app" }]);
    expect(fallbackCalls).toHaveLength(1);
    expect(fallbackCalls[0]!.kind).toBe("generation");

    const spec = parseSpec((composed.structuredContent as { spec: unknown }).spec);
    const eventResult = await client.callTool({
      name: "kohaku_event",
      arguments: {
        intent: { canonical: spec.intent.canonical, params: spec.intent.params },
        on: "c.select",
        payload: { month: "2026-05" },
      },
    });
    expect(eventResult.isError).toBeFalsy();
    // interacted is recorded exactly once, before the recompose's own composed/fallback pair below.
    expect(interactedCalls).toEqual([
      {
        intentHash: spec.intent.hash,
        componentId: "c",
        on: "c.select",
        payload: { month: "2026-05" },
        surface: "mcp-app",
      },
    ]);
    // The recompose triggered by kohaku_event goes through composeAndPackage too, so composed/fallback fire again.
    expect(composedCalls).toHaveLength(2);
    expect(fallbackCalls).toHaveLength(2);
  });

  it("when both recorder and the legacy onComposed are wired, recorder takes priority (onComposed is not also called)", async () => {
    const composedCalls: string[] = [];
    let onComposedCalls = 0;
    const recorder: ViewRecorder = {
      async composed() {
        composedCalls.push("recorder");
      },
      async interacted() {},
    };
    const server = new McpServer({ name: "kohaku-recorder-priority", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      {
        compose: makeComposeCtx(),
        domain,
        authz,
        querySource: "sales",
        recorder,
        async onComposed() {
          onComposedCalls++;
        },
      },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    const client = new Client({ name: "recorder-priority-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });
    expect(result.isError).toBeFalsy();
    expect(composedCalls).toEqual(["recorder"]);
    expect(onComposedCalls).toBe(0);
  });
});

describe("cancellation propagation (host-mcp-apps)", () => {
  /** An LlmPort whose generateObject stays pending until `req.abort` fires, then rejects as ABORTED — the same
   * shape as host-rest's own abort-propagation test (packages/host-rest/test/observability.test.ts), adapted to
   * stay in flight so the tool call can be cancelled mid-generation rather than pre-aborted. */
  function pendingUntilAbortLlm(onStarted: () => void): LlmPort {
    return {
      provider: "abort-aware",
      modelId: "abort-model",
      async generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
        onStarted();
        return new Promise((_resolve, reject) => {
          req.abort?.addEventListener("abort", () => {
            reject(new LlmError("ABORTED", "aborted(test)"));
          });
        });
      },
      async generateText() {
        throw new Error("pendingUntilAbortLlm stub: generateText not supported");
      },
    };
  }

  /** A compose ctx with no fixedSpecs (forces the L1 generation route, unlike makeComposeCtx's L0 shortcut). */
  function noFixedComposeCtx(llm: LlmPort): ComposeContext {
    const cache = new Map<string, UISpec>();
    return {
      catalog: resolveCatalog(coreCatalog),
      llm,
      semantic: {
        async normalize(input) {
          return {
            canonical: "sales.trend",
            params: input.kind === "gui" ? { ...input.current?.params, ...input.params } : {},
            hash: "",
          };
        },
        async resolveQuery() {
          return { uri: TREND_REF };
        },
        async dataVersion() {
          return "sales@seed-1";
        },
      },
      storage: {
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
      },
      policy: {},
    };
  }

  it("aborting a kohaku_compose call mid-generation propagates into compose (trace.cancelled) and skips the audit record", async () => {
    let started: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const composedCalls: unknown[] = [];
    const recorder: ViewRecorder = {
      async composed() {
        composedCalls.push(undefined);
      },
      async interacted() {},
      async fallback() {
        composedCalls.push(undefined);
      },
    };
    const server = new McpServer({ name: "kohaku-cancel", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      {
        compose: noFixedComposeCtx(pendingUntilAbortLlm(() => started())),
        domain,
        authz,
        querySource: "sales",
        recorder,
      },
      { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
    );
    const client = new Client({ name: "cancel-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const controller = new AbortController();
    const callPromise = client.callTool(
      { name: "kohaku_compose", arguments: { question: "Monthly revenue trend" } },
      { signal: controller.signal },
    );
    // Wait until the LLM call is actually in flight server-side before cancelling — a pre-abort would make the
    // SDK client reject before ever sending the request, never exercising the server-side abort propagation.
    await startedPromise;
    controller.abort();
    // The client-side promise rejects locally as soon as it cancels (it does not wait for the server's eventual
    // response) — that rejection is expected and is not what this test is verifying.
    await callPromise.catch(() => {});

    // Give the server's still-running handler (composeAndAudit -> composeForTool -> composeWithFixation ->
    // compose(), which the client-side rejection above does not stop) time to finish in the background.
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 0));

    // A cancelled compose is not a generation failure; it must not be recorded (parity with the REST profile's
    // deliverComposed/finishStream guard — see host-rest's "cancelled compose skips lineage recording" test).
    expect(composedCalls).toHaveLength(0);
  });
});

describe("bounded snapshot resolution shared with initial-data preresolution (host-mcp-apps)", () => {
  const SNAPSHOT_RENDERER_HTML =
    '<!DOCTYPE html><html><body><div id="root"></div>' +
    '<script id="kohaku-snapshot" type="application/json">null</script></body></html>';

  it("kohaku_render_snapshot resolves 20 refs with bounded concurrency (in-flight peaks above 1, never exceeds 8)", async () => {
    const componentCount = 20;
    const refFor = (i: number): string => `query://sales/trend?granularity=month&metric=revenue&idx=${i}`;
    let inFlight = 0;
    let maxInFlight = 0;
    const slowDomain: DomainPort = {
      async listOperations() {
        return [];
      },
      async invoke() {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight--;
        return DATA;
      },
    };
    const base = makeComposeCtx();
    const composeCtx: ComposeContext = {
      ...base,
      policy: {
        fixedSpecs: {
          async lookup() {
            return (intentArg): UISpec => ({
              kohaku: "0.1",
              intent: intentArg,
              dataVersion: "x",
              components: [
                {
                  id: "root",
                  type: "layout.stack",
                  props: {},
                  children: Array.from({ length: componentCount }, (_, i) => `c${i}`),
                },
                ...Array.from({ length: componentCount }, (_, i) => ({
                  id: `c${i}`,
                  type: "presentChart",
                  props: { kind: "line" as const, x: "month", y: "revenue" },
                  data: { $ref: refFor(i) },
                })),
              ],
              events: [],
              provenance: { tier: "L0" as const, composedBy: "test", cache: "miss" as const },
            });
          },
        },
      },
    };
    const server = new McpServer({ name: "kohaku-snapshot-concurrency", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      { compose: composeCtx, domain: slowDomain, authz, querySource: "sales" },
      {
        rendererHtml: SNAPSHOT_RENDERER_HTML,
        snapshotWriter: async (_fileName, _html) => "/abs/snapshots/x.html",
      },
    );
    const client = new Client({ name: "snapshot-concurrency-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const result = await client.callTool({
      name: "kohaku_render_snapshot",
      arguments: { question: "20 components" },
    });
    expect(result.isError).toBeFalsy();
    // Bounded concurrency: more than one worker ran at once (not serial, unlike the pre-fix one-at-a-time
    // loop), but never exceeding the pool size (unlike the pre-fix unbounded Promise.all).
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });

  it("legacyUiResource co-emission reuses preresolveInitialData's resolution instead of re-invoking domain.invoke (dedup)", async () => {
    const calls: unknown[] = [];
    const countingDomain: DomainPort = {
      async listOperations() {
        return [];
      },
      async invoke(op, args) {
        calls.push({ op, args });
        return DATA;
      },
    };
    const server = new McpServer({ name: "kohaku-legacy-dedup", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      { compose: bindComposeCtxA(), domain: countingDomain, authz, querySource: "sales" },
      { rendererHtml: SNAPSHOT_RENDERER_HTML, legacyUiResource: true },
    );
    const client = new Client({ name: "legacy-dedup-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Trend with region switch" },
    });
    expect(result.isError).toBeFalsy();
    // 3 bind variants (us/eu/jp): each resolved exactly once. Before this fix, the legacyUiResource snapshot
    // co-emission re-resolved the identical ref set a second time, doubling domain.invoke calls.
    expect(calls).toHaveLength(3);
  });
});

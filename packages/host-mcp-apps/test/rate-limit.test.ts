import type { ComposeContext } from "@kohaku-ui/composer";
import type { PolicyRateLimiter, PolicyRateLimiterTakeParams } from "@kohaku-ui/host-core";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type {
  AuthzPort,
  DomainPort,
  RateLimitResult,
  SemanticPort,
  TabularData,
  UISpec,
} from "@kohaku-ui/spec-core";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { attachKohakuToMcpServer, type McpHostDeps } from "../src/index.js";

// McpHostDeps.rateLimiter (port of the REST profile's rate-limit-middleware.test.ts, adapted to tool
// calls). Reuses principal.test.ts's fixture style (a fixedSpecs L0 shortcut bound to TREND_REF — the LLM
// must never be called) rather than importing it (this package's tests are self-contained per file).

const TREND_REF = "query://sales/trend?granularity=month&metric=revenue";

const DATA: TabularData = {
  columns: [
    { key: "month", type: "string" },
    { key: "revenue", type: "number" },
  ],
  rows: [{ month: "2026-04", revenue: 100 }],
  dataVersion: "sales@seed-1",
};

function makeSemantic(): SemanticPort {
  return {
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
  };
}

/** A ComposeContext with a single-ref fixed chart Spec bound to TREND_REF (mirrors principal.test.ts). */
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
    semantic: makeSemantic(),
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

function alwaysAllowAuthz(): AuthzPort {
  return {
    async issueCapability() {
      return "cap";
    },
    async verify() {
      return { ok: true };
    },
  };
}

function recordingDomain(options?: { operations?: { name: string; description: string }[] }): DomainPort {
  return {
    async listOperations() {
      return options?.operations ?? [];
    },
    async invoke(op) {
      if (op === "trend") return DATA;
      if (op === "annotate") return { ok: true };
      throw new Error(`unknown op ${op}`);
    },
  };
}

/** A rate limiter stub whose take() always returns `result` and records every call (port of
 * rate-limit-middleware.test.ts's stubRateLimiter). */
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

async function connectClient(deps: McpHostDeps): Promise<Client> {
  const server = new McpServer({ name: "kohaku-rate-limit-test", version: "0.1.0" });
  attachKohakuToMcpServer(server, deps, {
    rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>",
  });
  const client = new Client({ name: "rate-limit-test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function baseDeps(extra?: Partial<McpHostDeps>): McpHostDeps {
  return {
    compose: makeComposeCtx(),
    domain: recordingDomain({ operations: [{ name: "annotate", description: "annotate (write)" }] }),
    authz: alwaysAllowAuthz(),
    querySource: "sales",
    ...extra,
  };
}

describe("MCP rate limiting: backward compatibility", () => {
  it("does not affect kohaku_compose when deps.rateLimiter is unset", async () => {
    const client = await connectClient(baseDeps());
    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });
    expect(result.isError).toBeFalsy();
  });
});

describe("MCP rate limiting: denial", () => {
  it("returns a structured RATE_LIMITED tool error with retryAfterMs for kohaku_compose", async () => {
    const { limiter } = stubRateLimiter({ allow: false, retryAfterMs: 2500 });
    const client = await connectClient(baseDeps({ rateLimiter: limiter }));
    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: "RATE_LIMITED", message: "rate limit exceeded", retryAfterMs: 2500 },
    });
  });

  it("returns a structured RATE_LIMITED tool error without retryAfterMs when not given", async () => {
    const { limiter } = stubRateLimiter({ allow: false });
    const client = await connectClient(baseDeps({ rateLimiter: limiter }));
    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: "RATE_LIMITED", message: "rate limit exceeded" },
    });
  });

  it("denies kohaku_action with routeClass 'action'", async () => {
    const { limiter, calls } = stubRateLimiter({ allow: false, retryAfterMs: 1000 });
    const client = await connectClient(baseDeps({ rateLimiter: limiter }));
    const result = await client.callTool({
      name: "kohaku_action",
      arguments: { action: "annotate", payload: {}, capability: "cap" },
    });
    expect(result.isError).toBe(true);
    expect(calls[0]?.routeClass).toBe("action");
  });

  it("denies kohaku_resolve_binding with routeClass 'resolve'", async () => {
    const { limiter, calls } = stubRateLimiter({ allow: false, retryAfterMs: 1000 });
    const client = await connectClient(baseDeps({ rateLimiter: limiter }));
    const result = await client.callTool({
      name: "kohaku_resolve_binding",
      arguments: { ref: TREND_REF, capability: "cap" },
    });
    expect(result.isError).toBe(true);
    expect(calls[0]?.routeClass).toBe("resolve");
  });

  it("denies kohaku_event with routeClass 'compose'", async () => {
    const { limiter, calls } = stubRateLimiter({ allow: false, retryAfterMs: 1000 });
    const client = await connectClient(baseDeps({ rateLimiter: limiter }));
    const result = await client.callTool({
      name: "kohaku_event",
      arguments: { intent: { canonical: "sales.trend", params: {} }, on: "c.pointClick", payload: {} },
    });
    expect(result.isError).toBe(true);
    expect(calls[0]?.routeClass).toBe("compose");
  });
});

describe("MCP rate limiting: allow", () => {
  it("lets the request through and the handler still runs", async () => {
    const { limiter } = stubRateLimiter({ allow: true });
    const client = await connectClient(baseDeps({ rateLimiter: limiter }));
    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { spec?: UISpec } | undefined)?.spec?.provenance.tier).toBe("L0");
  });
});

describe("MCP rate limiting: bucket key", () => {
  it("keys the bucket by the resolved principal id when resolvePrincipal is wired (two callers on the same connection never share a bucket)", async () => {
    const { limiter, calls } = stubRateLimiter({ allow: true });
    const client = await connectClient(
      baseDeps({
        rateLimiter: limiter,
        resolvePrincipal: (extra) => ({ id: String(extra.mcpReq._meta?.["principal"] ?? "anon") }),
      }),
    );
    await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
      _meta: { principal: "alice" },
    });
    await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
      _meta: { principal: "bob" },
    });
    expect(calls.map((c) => c.principal)).toEqual(["alice", "bob"]);
    expect(calls.every((c) => c.tenant === undefined)).toBe(true);
  });

  it(
    "falls back to the literal 'anonymous' (not the constant fallback principal id 'mcp-user') when " +
      "resolvePrincipal is unset and the transport has no sessionId (in-memory transport) -- this only " +
      "proves the fallback branch is distinct from principal.id, not per-session isolation, which needs a " +
      "real Streamable HTTP session (out of scope for this in-process test harness)",
    async () => {
      const { limiter, calls } = stubRateLimiter({ allow: true });
      const client = await connectClient(baseDeps({ rateLimiter: limiter }));
      await client.callTool({
        name: "kohaku_compose",
        arguments: { question: "Monthly revenue trend" },
      });
      expect(calls[0]?.principal).toBe("anonymous");
    },
  );
});

describe("MCP rate limiting: rateLimitKey hook", () => {
  it("keys the bucket by rateLimitKey(extra), taking precedence over resolvePrincipal and sessionId", async () => {
    const { limiter, calls } = stubRateLimiter({ allow: true });
    const client = await connectClient(
      baseDeps({
        rateLimiter: limiter,
        resolvePrincipal: () => ({ id: "principal-id" }),
        rateLimitKey: async (extra) => `ip:${String(extra.mcpReq._meta?.["ip"] ?? "unknown")}`,
      }),
    );
    await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
      _meta: { ip: "10.0.0.1" },
    });
    await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
      _meta: { ip: "10.0.0.2" },
    });
    expect(calls.map((c) => c.principal)).toEqual(["ip:10.0.0.1", "ip:10.0.0.2"]);
  });

  it("a throwing rateLimitKey is fail-closed: a tool error, reported to onError, and the limiter is never consulted", async () => {
    const { limiter, calls } = stubRateLimiter({ allow: true });
    const errors: { endpoint: string; error: unknown }[] = [];
    const client = await connectClient(
      baseDeps({
        rateLimiter: limiter,
        rateLimitKey: () => {
          throw new Error("key lookup down");
        },
        onError: (info) => void errors.push(info),
      }),
    );
    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.endpoint).toBe("kohaku_compose");
  });
});

describe("MCP rate limiting: onRateLimited observer", () => {
  it("is notified on denial with the bucket key and the call's correlation id, and not on an allowed call", async () => {
    const seen: unknown[] = [];
    const denied = await connectClient(
      baseDeps({
        rateLimiter: stubRateLimiter({ allow: false, retryAfterMs: 1000 }).limiter,
        rateLimitKey: () => "client-7",
        onRateLimited: (info) => void seen.push(info),
      }),
    );
    await denied.callTool({
      name: "kohaku_action",
      arguments: { action: "annotate", payload: {}, capability: "cap" },
    });
    expect(seen).toEqual([
      {
        principal: "client-7",
        routeClass: "action",
        requestId: expect.stringMatching(/^mcp:[0-9a-f-]{36}:\d+$/),
      },
    ]);

    const allowedSeen: unknown[] = [];
    const allowed = await connectClient(
      baseDeps({
        rateLimiter: stubRateLimiter({ allow: true }).limiter,
        onRateLimited: (info) => void allowedSeen.push(info),
      }),
    );
    await allowed.callTool({ name: "kohaku_compose", arguments: { question: "Monthly revenue trend" } });
    expect(allowedSeen).toEqual([]);
  });

  it("never awaits the observer: a hung one cannot delay the RATE_LIMITED result", async () => {
    const client = await connectClient(
      baseDeps({
        rateLimiter: stubRateLimiter({ allow: false }).limiter,
        onRateLimited: () => new Promise<void>(() => {}),
      }),
    );
    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });
    expect(result.isError).toBe(true);
  });
});

describe("MCP rate limiting: unkeyed-limiter startup warning", () => {
  async function freshAttach(deps: McpHostDeps): Promise<void> {
    vi.resetModules();
    const mod = await import("../src/index.js");
    mod.attachKohakuToMcpServer(new McpServer({ name: "warn-test", version: "0.1.0" }), deps, {
      rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>",
    });
  }

  it("warns once per process when rateLimiter is wired without resolvePrincipal or rateLimitKey", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const deps = baseDeps({ rateLimiter: stubRateLimiter({ allow: true }).limiter });
      await freshAttach(deps);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/rateLimitKey/);
      const mod = await import("../src/index.js");
      mod.attachKohakuToMcpServer(new McpServer({ name: "warn-test-2", version: "0.1.0" }), deps, {
        rendererHtml: "x",
      });
      expect(warn).toHaveBeenCalledTimes(1); // a second (per-request) attach stays silent
    } finally {
      warn.mockRestore();
    }
  });

  it("stays silent when the limiter is keyed (resolvePrincipal or rateLimitKey) or absent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { limiter } = stubRateLimiter({ allow: true });
      await freshAttach(baseDeps({ rateLimiter: limiter, resolvePrincipal: () => ({ id: "u" }) }));
      await freshAttach(baseDeps({ rateLimiter: limiter, rateLimitKey: () => "k" }));
      await freshAttach(baseDeps());
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

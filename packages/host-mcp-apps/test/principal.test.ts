import type { ComposeContext } from "@kohaku-ui/composer";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type {
  AuthzPort,
  DomainPort,
  SemanticPort,
  SessionContext,
  TabularData,
  UISpec,
} from "@kohaku-ui/spec-core";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { attachKohakuToMcpServer, type McpHostDeps } from "../src/index.js";

// Per-call principal resolution (McpHostDeps.resolvePrincipal): resolved once per tool call, inside the tool
// handler itself, before capability issuance / SessionContext.principal / the initial-data preresolution's
// domain.invoke calls ever see it. Fallback order: resolvePrincipal(extra) -> deps.principal -> the built-in
// anonymous principal. A throw is fail-closed (isError + onError), never silently downgraded to anonymous.
//
// Reuses the shared-fixture style of locale.test.ts's makeClient (a ComposeContext with a single-ref fixed
// chart Spec) and mcp.test.ts:290-345's domain/authz capture pattern (a DomainPort/AuthzPort that records the
// principal each call carried). `client.callTool({name, arguments, _meta})` reaching `extra.mcpReq._meta` is
// already proven by mcp.test.ts:792-802's traceparent test.

const TREND_REF = "query://sales/trend?granularity=month&metric=revenue";

const DATA: TabularData = {
  columns: [
    { key: "month", type: "string" },
    { key: "revenue", type: "number" },
  ],
  rows: [{ month: "2026-04", revenue: 100 }],
  dataVersion: "sales@seed-1",
};

/** Deterministic SemanticPort that records the SessionContext (including .principal) of each normalize call. */
function makeSemantic(sessions: SessionContext[]): SemanticPort {
  return {
    async normalize(input, session) {
      sessions.push(session);
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

/** A ComposeContext with a single-ref fixed chart Spec bound to TREND_REF (the L0 shortcut — the LLM must
 * never be called). Mirrors locale.test.ts / mcp.test.ts's makeComposeCtx. */
function makeComposeCtx(semantic: SemanticPort): ComposeContext {
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
    semantic,
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
            // No declared events (same as locale.test.ts's fixedSpecsFor) — kohaku_event's "gui" resolveIntent
            // call does not require the fired event to be pre-declared here.
            events: [],
            provenance: { tier: "L0", composedBy: "test", cache: "miss" },
          });
        },
      },
    },
  };
}

async function connectClient(deps: McpHostDeps): Promise<Client> {
  const server = new McpServer({ name: "kohaku-principal-test", version: "0.1.0" });
  attachKohakuToMcpServer(server, deps, {
    rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>",
  });
  const client = new Client({ name: "principal-test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** An AuthzPort that always accepts (verify never returns a principal — every fallback-to-per-call-principal
 * site in server.ts is therefore exercised whenever a call succeeds). */
function alwaysAllowAuthz(issuedFor: string[] = []): AuthzPort {
  return {
    async issueCapability(principal) {
      issuedFor.push(principal.id);
      return "cap";
    },
    async verify() {
      return { ok: true };
    },
  };
}

/** A DomainPort that records the principal each invoke call carried and answers "trend" / "annotate". */
function recordingDomain(
  domainInvokePrincipals: string[],
  options?: { operations?: { name: string; description: string }[] },
): DomainPort {
  return {
    async listOperations() {
      return options?.operations ?? [];
    },
    async invoke(op, _args, ctx) {
      domainInvokePrincipals.push(ctx.principal.id);
      if (op === "trend") return DATA;
      if (op === "annotate") return { ok: true };
      throw new Error(`unknown op ${op}`);
    },
  };
}

describe("MCP per-tool-call principal resolution (McpHostDeps.resolvePrincipal)", () => {
  it("kohaku_compose: two callers on the same connection each get their own principal through issueCapability, normalize, and initial-data preresolution (sync resolver)", async () => {
    const issuedFor: string[] = [];
    const normalizeSessions: SessionContext[] = [];
    const domainInvokePrincipals: string[] = [];
    const client = await connectClient({
      compose: makeComposeCtx(makeSemantic(normalizeSessions)),
      domain: recordingDomain(domainInvokePrincipals),
      authz: alwaysAllowAuthz(issuedFor),
      querySource: "sales",
      // Sync resolver (no `async`/Promise) — the plan's exact shape.
      resolvePrincipal: (extra) => ({ id: String(extra.mcpReq._meta?.["principal"] ?? "anon") }),
    });

    const alice = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
      _meta: { principal: "alice" },
    });
    expect(alice.isError).toBeFalsy();
    const bob = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
      _meta: { principal: "bob" },
    });
    expect(bob.isError).toBeFalsy();

    expect(issuedFor).toEqual(["alice", "bob"]);
    expect(normalizeSessions.map((s) => s.principal?.id)).toEqual(["alice", "bob"]);
    expect(domainInvokePrincipals).toEqual(["alice", "bob"]);
  });

  it("kohaku_resolve_binding: when authz.verify returns no principal, the per-call resolved principal reaches domain.invoke (async resolver)", async () => {
    const domainInvokePrincipals: string[] = [];
    const client = await connectClient({
      compose: makeComposeCtx(makeSemantic([])),
      domain: recordingDomain(domainInvokePrincipals),
      authz: alwaysAllowAuthz(),
      querySource: "sales",
      // Async resolver — the other half of "sync + async resolvers".
      resolvePrincipal: async (extra) => ({ id: String(extra.mcpReq._meta?.["principal"] ?? "anon") }),
    });

    const result = await client.callTool({
      name: "kohaku_resolve_binding",
      arguments: { ref: TREND_REF, capability: "cap" },
      _meta: { principal: "alice" },
    });

    expect(result.isError).toBeFalsy();
    expect(domainInvokePrincipals).toEqual(["alice"]);
  });

  it("kohaku_action: when authz.verify returns no principal, the per-call resolved principal reaches domain.invoke", async () => {
    const domainInvokePrincipals: string[] = [];
    const client = await connectClient({
      compose: makeComposeCtx(makeSemantic([])),
      domain: recordingDomain(domainInvokePrincipals, {
        operations: [{ name: "annotate", description: "annotate (write)" }],
      }),
      authz: alwaysAllowAuthz(),
      querySource: "sales",
      resolvePrincipal: (extra) => ({ id: String(extra.mcpReq._meta?.["principal"] ?? "anon") }),
    });

    const result = await client.callTool({
      name: "kohaku_action",
      arguments: { action: "annotate", payload: {}, capability: "cap" },
      _meta: { principal: "bob" },
    });

    expect(result.isError).toBeFalsy();
    expect(domainInvokePrincipals).toEqual(["bob"]);
  });

  it("kohaku_event: the per-call resolved principal rides the normalize session (mirrors registerEventTool's mcpSession)", async () => {
    const normalizeSessions: SessionContext[] = [];
    const client = await connectClient({
      compose: makeComposeCtx(makeSemantic(normalizeSessions)),
      domain: recordingDomain([]),
      authz: alwaysAllowAuthz(),
      querySource: "sales",
      resolvePrincipal: (extra) => ({ id: String(extra.mcpReq._meta?.["principal"] ?? "anon") }),
    });

    const result = await client.callTool({
      name: "kohaku_event",
      arguments: { intent: { canonical: "sales.trend", params: {} }, on: "c.pointClick", payload: {} },
      _meta: { principal: "carol" },
    });

    expect(result.isError).toBeFalsy();
    expect(normalizeSessions[0]?.surface).toBe("mcp-app");
    expect(normalizeSessions[0]?.principal?.id).toBe("carol");
  });

  describe("fallback order: resolvePrincipal -> deps.principal -> the built-in anonymous principal", () => {
    it("unwired resolvePrincipal, no deps.principal -> the built-in anonymous principal (mcp-user)", async () => {
      const issuedFor: string[] = [];
      const client = await connectClient({
        compose: makeComposeCtx(makeSemantic([])),
        domain: recordingDomain([]),
        authz: alwaysAllowAuthz(issuedFor),
        querySource: "sales",
      });

      const result = await client.callTool({
        name: "kohaku_compose",
        arguments: { question: "Monthly revenue trend" },
      });

      expect(result.isError).toBeFalsy();
      expect(issuedFor).toEqual(["mcp-user"]);
    });

    it("unwired resolvePrincipal, deps.principal set -> that principal", async () => {
      const issuedFor: string[] = [];
      const client = await connectClient({
        compose: makeComposeCtx(makeSemantic([])),
        domain: recordingDomain([]),
        authz: alwaysAllowAuthz(issuedFor),
        querySource: "sales",
        principal: { id: "svc-account", roles: ["service"] },
      });

      const result = await client.callTool({
        name: "kohaku_compose",
        arguments: { question: "Monthly revenue trend" },
      });

      expect(result.isError).toBeFalsy();
      expect(issuedFor).toEqual(["svc-account"]);
    });
  });

  it("a throwing resolvePrincipal is fail-closed: isError with the generic message, onError({endpoint:'kohaku_compose'}) fires, and the domain/authz are never reached", async () => {
    const domainCalls: string[] = [];
    const onErrorCalls: { endpoint: string; error: unknown }[] = [];
    const domain: DomainPort = {
      async listOperations() {
        return [];
      },
      async invoke(op) {
        domainCalls.push(op);
        return DATA;
      },
    };
    const authz: AuthzPort = {
      async issueCapability() {
        throw new Error("must not be called: resolvePrincipal already failed");
      },
      async verify() {
        throw new Error("must not be called: resolvePrincipal already failed");
      },
    };
    const client = await connectClient({
      compose: makeComposeCtx(makeSemantic([])),
      domain,
      authz,
      querySource: "sales",
      resolvePrincipal: () => {
        throw new Error("identity provider unavailable");
      },
      onError: (info) => {
        onErrorCalls.push(info);
      },
    });

    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });

    expect(result.isError).toBe(true);
    // A plain (untyped) thrown error never echoes its own message back to the caller (host-core's
    // isTypedHostError) — same rule as every other safeTool-caught failure in this profile.
    expect((result.content as { type: string; text: string }[])[0]!.text).toBe(
      "internal error; see the observability hook (onError) for details",
    );
    expect(domainCalls).toEqual([]);
    expect(onErrorCalls).toHaveLength(1);
    expect(onErrorCalls[0]!.endpoint).toBe("kohaku_compose");
    expect(onErrorCalls[0]!.error).toBeInstanceOf(Error);
  });
});

import type { ComposeContext } from "@kohaku-ui/composer";
import type { ViewRecorder } from "@kohaku-ui/host-core";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import {
  type AuthzPort,
  type DomainPort,
  parseSpec,
  type StoragePort,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
  attachKohakuToMcpServer,
  CAPABILITY_META_KEY,
  type McpHostDeps,
  REQUEST_ID_META_KEY,
} from "../src/index.js";

// Characterization of the compose delivery sequence (compose -> capability -> action manifest -> audit
// record) as the MCP profile runs it today, pinned BEFORE the shared host-core helpers are extracted:
// - the exact onError calls (endpoint, order, which error) when several delivery steps fail in one call,
// - the exact recorder.composed / recorder.fallback argument shapes (key presence and key order),
// - the legacy onComposed branch when no recorder is wired.
// These tests describe what the code does, not what it should do.

const REF = "query://sales/trend?granularity=month&metric=revenue";

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

const baseCtx = {
  catalog: resolveCatalog(coreCatalog),
  semantic: {
    async normalize(input) {
      return {
        canonical: "sales.trend",
        params: input.kind === "gui" ? { ...input.current?.params, ...input.params } : {},
        hash: "",
      };
    },
    async resolveQuery() {
      return { uri: REF };
    },
    async dataVersion() {
      return "sales@seed-1";
    },
  },
} satisfies Pick<ComposeContext, "catalog" | "semantic">;

/** A fixed L0 template declaring one write action and no data reference. */
function fixedCtx(): ComposeContext {
  return {
    ...baseCtx,
    storage: stubStorage(),
    llm: new FakeLlm(),
    policy: {
      fixedSpecs: {
        async lookup() {
          return (intentArg): UISpec => ({
            kohaku: "0.1",
            intent: intentArg,
            dataVersion: "x",
            components: [{ id: "root", type: "layout.stack", props: {}, children: [] }],
            events: [{ on: "root.annotateClick", emit: "action.invoke", payload: { action: "annotate" } }],
            provenance: { tier: "L0", composedBy: "test", cache: "miss" },
          });
        },
      },
    },
  };
}

/** A compose context whose L1 always fails validation, so every compose ends in a deterministic fallback. */
function fallbackCtx(): ComposeContext {
  return {
    ...baseCtx,
    storage: stubStorage(),
    llm: new FakeLlm({ objects: [{ components: [], events: [] }] }),
    policy: {},
  };
}

const okAuthz: AuthzPort = {
  async issueCapability(_p, scopes) {
    return `cap:${scopes.map((s) => s.ref).join("|")}`;
  },
  async verify() {
    return { ok: true, principal: { id: "tester" } };
  },
};

const okDomain: DomainPort = {
  async listOperations() {
    return [{ name: "annotate", description: "annotate (write)" }];
  },
  async invoke() {
    return {};
  },
};

/** listOperations always rejects: the memoized operation index is retried and rejects every time. */
const failingDomain: DomainPort = {
  async listOperations() {
    throw new Error("list-ops down");
  },
  async invoke() {
    return {};
  },
};

type Seen = { endpoint: string; error: unknown; correlationId?: string };

async function connect(deps: McpHostDeps): Promise<Client> {
  const server = new McpServer({ name: "kohaku-delivery-characterization", version: "0.1.0" });
  attachKohakuToMcpServer(server, deps, {
    rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>",
  });
  const client = new Client({ name: "delivery-characterization-client", version: "0.0.1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

function collectErrors(): { seen: Seen[]; onError: NonNullable<McpHostDeps["onError"]> } {
  const seen: Seen[] = [];
  return {
    seen,
    onError: (info) => {
      seen.push({
        endpoint: info.endpoint,
        error: info.error,
        ...(info.correlationId != null ? { correlationId: info.correlationId } : {}),
      });
    },
  };
}

function messages(seen: Seen[]): string[] {
  return seen.map((s) => (s.error as Error).message);
}

/**
 * attachKohakuToMcpServer validates the operation index eagerly, so a rejecting listOperations produces one
 * "attach.operationIndex" report before any tool call. Pin it, then return only the per-call reports.
 */
function afterAttach(seen: Seen[]): Seen[] {
  expect(seen[0]!.endpoint).toBe("attach.operationIndex");
  expect((seen[0]!.error as Error).message).toBe("list-ops down");
  return seen.slice(1);
}

describe("delivery onError sequence on kohaku_compose (host-mcp-apps characterization)", () => {
  it("listOperations rejects AND recorder.composed throws: capability -> actions -> record, and the tool result still carries the spec", async () => {
    const { seen, onError } = collectErrors();
    const client = await connect({
      compose: fixedCtx(),
      domain: failingDomain,
      authz: okAuthz,
      querySource: "sales",
      recorder: {
        async composed() {
          throw new Error("record down");
        },
        async interacted() {},
      },
      onError,
    });
    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Annotation form" },
    });
    expect(result.isError).toBeFalsy();
    expect(parseSpec((result.structuredContent as { spec: unknown }).spec).provenance.tier).toBe("L0");
    const meta = result._meta as Record<string, unknown>;
    expect(typeof meta[CAPABILITY_META_KEY]).toBe("string");
    expect(meta["kohaku/actions"]).toBeUndefined();

    const delivery = afterAttach(seen);
    // The fail-closed allowed set drops the declared write action, which is reported as a second
    // capability error right after the listOperations rejection itself.
    expect(delivery.map((s) => s.endpoint)).toEqual([
      "compose.capability",
      "compose.capability",
      "compose.actions",
      "compose",
    ]);
    expect(messages(delivery)).toEqual([
      "list-ops down",
      'write scope dropped: action "annotate" is not a DomainPort operation (listOperations)',
      "list-ops down",
      "record down",
    ]);
    // Only the record report carries the call's correlation id (the other reports omit it).
    expect(delivery.map((s) => s.correlationId)).toEqual([
      undefined,
      undefined,
      undefined,
      meta[REQUEST_ID_META_KEY],
    ]);
    await client.close();
  });

  it("authz.issueCapability rejects AND listOperations rejects AND recorder throws: capability failure is fail-closed (tool error), actions and the recorder are never reached", async () => {
    const { seen, onError } = collectErrors();
    let recorderCalls = 0;
    const authz: AuthzPort = {
      async issueCapability() {
        throw new Error("issue down");
      },
      async verify() {
        return { ok: true, principal: { id: "tester" } };
      },
    };
    const client = await connect({
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
    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Annotation form" },
    });
    expect(result.isError).toBe(true);

    const delivery = afterAttach(seen);
    expect(delivery.map((s) => s.endpoint)).toEqual([
      "compose.capability",
      "compose.capability",
      "kohaku_compose",
    ]);
    expect(messages(delivery)).toEqual([
      "list-ops down",
      'write scope dropped: action "annotate" is not a DomainPort operation (listOperations)',
      "issue down",
    ]);
    expect(recorderCalls).toBe(0);
    await client.close();
  });

  it("a healthy domain delivers the actions manifest next to the capability", async () => {
    const client = await connect({
      compose: fixedCtx(),
      domain: okDomain,
      authz: okAuthz,
      querySource: "sales",
    });
    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Annotation form" },
    });
    expect(result.isError).toBeFalsy();
    const meta = result._meta as Record<string, unknown>;
    expect(meta["kohaku/actions"]).toEqual({ annotate: { tier: "auto" } });
    await client.close();
  });
});

describe("recorder argument shapes (host-mcp-apps characterization)", () => {
  it("composed carries only spec/trace/surface (no specHash, no session meta); fallback carries spec/reason/kind/surface/correlationId", async () => {
    const composed: Record<string, unknown>[] = [];
    const fallback: Record<string, unknown>[] = [];
    const recorder: ViewRecorder = {
      async composed(args) {
        composed.push(args as unknown as Record<string, unknown>);
      },
      async fallback(args) {
        fallback.push(args as unknown as Record<string, unknown>);
      },
      async interacted() {},
    };
    const client = await connect({
      compose: fallbackCtx(),
      domain: okDomain,
      authz: okAuthz,
      querySource: "sales",
      recorder,
    });
    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });
    expect(result.isError).toBeFalsy();
    const requestId = (result._meta as Record<string, unknown>)[REQUEST_ID_META_KEY];
    expect(typeof requestId).toBe("string");

    expect(composed).toHaveLength(1);
    expect(Object.keys(composed[0]!)).toEqual(["spec", "trace", "surface"]);
    expect(composed[0]!["surface"]).toBe("mcp-app");
    expect((composed[0]!["trace"] as { correlationId?: string }).correlationId).toBe(requestId);

    expect(fallback).toHaveLength(1);
    expect(Object.keys(fallback[0]!)).toEqual(["spec", "reason", "kind", "surface", "correlationId"]);
    expect(fallback[0]).toMatchObject({ kind: "generation", surface: "mcp-app", correlationId: requestId });
    await client.close();
  });

  it("a non-fallback spec records composed only (no fallback call)", async () => {
    let composedCalls = 0;
    let fallbackCalls = 0;
    const client = await connect({
      compose: fixedCtx(),
      domain: okDomain,
      authz: okAuthz,
      querySource: "sales",
      recorder: {
        async composed() {
          composedCalls++;
        },
        async fallback() {
          fallbackCalls++;
        },
        async interacted() {},
      },
    });
    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Annotation form" },
    });
    expect(result.isError).toBeFalsy();
    expect(composedCalls).toBe(1);
    expect(fallbackCalls).toBe(0);
    await client.close();
  });

  it("without a recorder the legacy onComposed(spec, trace) is called once, with no fallback recording even for a fallback spec", async () => {
    const calls: unknown[][] = [];
    const client = await connect({
      compose: fallbackCtx(),
      domain: okDomain,
      authz: okAuthz,
      querySource: "sales",
      async onComposed(...args: unknown[]) {
        calls.push(args);
      },
    });
    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
    const [spec, trace] = calls[0] as [UISpec, { correlationId?: string }];
    expect(spec.provenance.fallback?.kind).toBe("generation");
    expect(trace.correlationId).toBe((result._meta as Record<string, unknown>)[REQUEST_ID_META_KEY]);
    await client.close();
  });
});

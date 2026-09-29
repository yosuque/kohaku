import type { FixedSpecSource } from "@kohaku-ui/composer";
import { intentToolsFromCatalog } from "@kohaku-ui/host-mcp-apps";
import { defineIntent } from "@kohaku-ui/intents";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { type DomainPort, SPEC_VERSION, type UISpec } from "@kohaku-ui/spec-core";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type CreateKohakuHostOptions, createKohakuHost, type KohakuHost } from "../src/create-host.js";
import { type AttachKohakuMcpOptions, attachKohakuMcp } from "../src/mcp.js";

const testIntentBuilder = defineIntent({
  canonical: "test.view",
  description: "a trivial test view",
  params: z.object({}),
  examples: ["show the view"],
  source: "test",
  queries: [{ path: "summary" }],
});

const domain: DomainPort = {
  async listOperations() {
    return [{ name: "summary", description: "test op" }];
  },
  async invoke() {
    return { columns: [], rows: [], dataVersion: "v1" };
  },
};

/** An L0 fixed Spec for "test.view", so compose() never has to call the (unscripted) FakeLlm. */
function fixedSpecs(): FixedSpecSource {
  return {
    async lookup(intent) {
      if (intent.canonical !== "test.view") return null;
      return (canonicalIntent): UISpec => ({
        kohaku: SPEC_VERSION,
        intent: canonicalIntent,
        dataVersion: "template",
        components: [{ id: "root", type: "text.heading", props: { level: 2, text: "hello" } }],
        events: [],
        provenance: { tier: "L0", composedBy: "test-fixed-spec", cache: "miss" },
      });
    },
  };
}

/** Builds a fresh host + McpServer pair for one test, mirroring how a product wires create-host + mcp.ts. */
function buildServer(
  attachExtras: Pick<AttachKohakuMcpOptions, "deps"> = {},
  onHost: (host: KohakuHost) => void = () => {},
  hostExtras: Pick<CreateKohakuHostOptions, "routes"> = {},
): McpServer {
  const host = createKohakuHost({
    ...hostExtras,
    domain,
    querySource: "test",
    llm: new FakeLlm(),
    intents: [testIntentBuilder.toIntentDef()],
    dataVersion: () => "v1",
    policy: { fixedSpecs: fixedSpecs(), allowL2: false },
    capabilitySecret: "test-secret-of-decent-length",
  });
  onHost(host);
  const server = new McpServer({ name: "kohaku-host-test", version: "0.0.1" });
  attachKohakuMcp(server, host, {
    rendererHtml: "<!doctype html><html><body></body></html>",
    intentTools: intentToolsFromCatalog([testIntentBuilder.toToolSource()]),
    ...attachExtras,
  });
  return server;
}

/**
 * Connects a Client to a freshly built McpServer via SDK v2's stateless HTTP entry, routed through an
 * in-process `fetch` bridge -- no real socket. See host-mcp-apps/test/connect-modern.ts for the fuller
 * version this is adapted from (kept local here since this package needs only the plain connect, not the
 * raw-JSON-RPC / Tasks-extension helpers that file also carries).
 */
async function connect(
  attachExtras: Pick<AttachKohakuMcpOptions, "deps"> = {},
  onHost: (host: KohakuHost) => void = () => {},
  hostExtras: Pick<CreateKohakuHostOptions, "routes"> = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const handler = createMcpHandler(() => buildServer(attachExtras, onHost, hostExtras));
  const client = new Client(
    { name: "kohaku-host-test-client", version: "0.0.1" },
    { versionNegotiation: { mode: "auto" } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://in-process.kohaku-host-test.invalid/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
  return {
    client,
    close: async () => {
      await client.close();
      await handler.close();
    },
  };
}

describe("attachKohakuMcp", () => {
  it("registers the built-in compose tool and the given intentTools, using the host's ports", async () => {
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("kohaku_compose");
      expect(names).toContain("test_view");
    } finally {
      await close();
    }
  });

  it("composes an L0 view through an intent tool, using the same Ports createKohakuHost built", async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({ name: "test_view", arguments: {} });
      expect(result.isError).not.toBe(true);
      const spec = (result.structuredContent as { spec: UISpec }).spec;
      // provenance.composedBy is stamped by the composer pipeline itself (not the fixedSpecs builder's
      // return value), so only `tier` distinguishes "this came from the L0 fixedSpecs path" here.
      expect(spec.provenance.tier).toBe("L0");
      expect(spec.components).toHaveLength(1);
      expect(spec.components[0]).toMatchObject({ id: "root", type: "text.heading" });
    } finally {
      await close();
    }
  });
  it("records MCP views into the host's View Lineage", async () => {
    let host: KohakuHost | undefined;
    const { client, close } = await connect({}, (h) => {
      host = h;
    });
    try {
      await client.callTool({ name: "test_view", arguments: {} });
      expect(await host?.lineage.list({ type: ["view.composed"] })).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("defaults onError to the console reporter, and deps passes McpHostDeps fields through", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, close } = await connect({
      deps: {
        resolvePrincipal: () => {
          throw new Error("identity lookup failed");
        },
      },
    });
    try {
      const result = await client.callTool({ name: "test_view", arguments: {} });
      // resolvePrincipal is fail-closed: it only reaches this outcome if `deps` got through.
      expect(result.isError).toBe(true);
      expect(
        log.mock.calls.some((c) => /\[kohaku\] mcp test_view.*identity lookup failed/.test(String(c[0]))),
      ).toBe(true);
    } finally {
      log.mockRestore();
      await close();
    }
  });

  it("deps.onError replaces the default reporter", async () => {
    const onError = vi.fn();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, close } = await connect({
      deps: {
        onError,
        resolvePrincipal: () => {
          throw new Error("nope");
        },
      },
    });
    try {
      await client.callTool({ name: "test_view", arguments: {} });
      expect(onError).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      await close();
    }
  });

  it("inherits the facade's rateLimiter, so a REST rate limit also denies MCP tool calls", async () => {
    const take = vi.fn(async () => ({ allow: false, retryAfterMs: 500 }));
    const onRateLimited = vi.fn();
    const { client, close } = await connect({}, () => {}, {
      routes: { rateLimiter: { take }, onRateLimited },
    });
    try {
      const result = await client.callTool({ name: "test_view", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.structuredContent)).toContain("RATE_LIMITED");
      expect(take).toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onRateLimited).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  });

  it("deps.rateLimiter overrides the facade's rateLimiter", async () => {
    const facadeTake = vi.fn(async () => ({ allow: false }));
    const { client, close } = await connect(
      { deps: { rateLimiter: { take: async () => ({ allow: true }) } } },
      () => {},
      { routes: { rateLimiter: { take: facadeTake } } },
    );
    try {
      const result = await client.callTool({ name: "test_view", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(facadeTake).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
});

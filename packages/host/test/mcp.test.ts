import type { FixedSpecSource } from "@kohaku-ui/composer";
import { intentToolsFromCatalog } from "@kohaku-ui/host-mcp-apps";
import { defineIntent } from "@kohaku-ui/intents";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { type DomainPort, SPEC_VERSION, type UISpec } from "@kohaku-ui/spec-core";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createKohakuHost } from "../src/create-host.js";
import { attachKohakuMcp } from "../src/mcp.js";

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
function buildServer(): McpServer {
  const host = createKohakuHost({
    domain,
    querySource: "test",
    llm: new FakeLlm(),
    intents: [testIntentBuilder.toIntentDef()],
    dataVersion: () => "v1",
    policy: { fixedSpecs: fixedSpecs(), allowL2: false },
    capabilitySecret: "test-secret-of-decent-length",
  });
  const server = new McpServer({ name: "kohaku-host-test", version: "0.0.1" });
  attachKohakuMcp(server, host, {
    rendererHtml: "<!doctype html><html><body></body></html>",
    intentTools: intentToolsFromCatalog([testIntentBuilder.toToolSource()]),
  });
  return server;
}

/**
 * Connects a Client to a freshly built McpServer via SDK v2's stateless HTTP entry, routed through an
 * in-process `fetch` bridge -- no real socket. See host-mcp-apps/test/connect-modern.ts for the fuller
 * version this is adapted from (kept local here since this package needs only the plain connect, not the
 * raw-JSON-RPC / Tasks-extension helpers that file also carries).
 */
async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
  const handler = createMcpHandler(buildServer);
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
});

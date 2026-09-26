import type { ComposeContext } from "@kohaku-ui/composer";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import {
  type AuthzPort,
  type DomainPort,
  type IntentInput,
  IntentValidationError,
  type Scope,
  type SemanticPort,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { attachKohakuToMcpServer, type IntentToolSource, intentToolsFromCatalog } from "../src/index.js";

// A directly-specified Intent must surface as a structured tool error (isError: true, a client-safe
// message), not an unhandled rejection, when the wired SemanticPort implements validateIntent and rejects
// it. Covers both MCP entry points that funnel a directly-specified Intent through host-core's
// resolveIntent: a generated intent tool (composeForTool's "intent" ComposeSource) and `${prefix}_event`'s
// freely-typed `intent` argument (the pre-event `current`).

const REF = "query://sales/summary?fy=2026&groupBy=region";

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
  async invoke() {
    return { columns: [], rows: [], dataVersion: "sales@seed-1" };
  },
};

/** Only "sales.trend" / "sales.quarterly_summary" with groupBy in {region, product, channel} validates. */
function validatingSemantic(): SemanticPort {
  return {
    async normalize(input) {
      if (input.kind === "gui") {
        return {
          canonical: input.current?.canonical ?? "sales.trend",
          params: { ...(input.current?.params ?? {}), ...input.params },
        };
      }
      return { canonical: "sales.trend", params: {} };
    },
    async resolveQuery() {
      return { uri: REF };
    },
    async dataVersion() {
      return "sales@seed-1";
    },
    async validateIntent(intent: IntentInput): Promise<IntentInput> {
      if (intent.canonical !== "sales.trend" && intent.canonical !== "sales.quarterly_summary") {
        throw new IntentValidationError(`unknown intent "${intent.canonical}"`);
      }
      const groupBy = (intent.params["groupBy"] as string | undefined) ?? "region";
      if (!["region", "product", "channel"].includes(groupBy)) {
        throw new IntentValidationError('param "groupBy": expected one of region, product, channel', [
          { path: "groupBy", message: 'param "groupBy": expected one of region, product, channel' },
        ]);
      }
      return { canonical: intent.canonical, params: { ...intent.params, groupBy } };
    },
  };
}

function makeComposeCtx(): ComposeContext {
  const cache = new Map<string, UISpec>();
  return {
    catalog: resolveCatalog(coreCatalog),
    llm: {
      provider: "fake",
      modelId: "fake",
      async generateObject() {
        throw new Error("LLM is not called (fixedSpecs path)");
      },
      async generateText() {
        throw new Error("no");
      },
    },
    semantic: validatingSemantic(),
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
              { id: "root", type: "layout.stack", props: {}, children: ["t"] },
              { id: "t", type: "text.heading", props: { level: 2, text: "Summary" } },
              { id: "c", type: "presentTable", props: {}, data: { $ref: refs[0]!.uri } },
            ],
            events: [],
            provenance: { tier: "L0", composedBy: "test", cache: "miss" },
          });
        },
      },
    },
  };
}

// The registered tool's own inputSchema deliberately uses a bare z.string() (not an enum) for groupBy, so
// an invalid value is not already rejected at the MCP protocol layer -- the point of this test is that
// validateIntent (a business-rule check the static schema cannot express) still catches it.
const DEFS: IntentToolSource[] = [
  {
    name: "sales.quarterly_summary",
    description: "Aggregate the sales for the given quarter by region/product/channel",
    params: z.object({ groupBy: z.string().default("region") }),
  },
];

describe("a directly-specified Intent that fails SemanticPort.validateIntent is a structured tool error", () => {
  let client: Client;

  beforeAll(async () => {
    const server = new McpServer({ name: "kohaku-intent-invalid-test", version: "0.1.0" });
    attachKohakuToMcpServer(
      server,
      { compose: makeComposeCtx(), domain, authz, querySource: "sales" },
      {
        rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>",
        intentTools: intentToolsFromCatalog(DEFS),
      },
    );
    client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  it("a generated intent tool call with an invalid param is a structured tool error, not a thrown exception", async () => {
    const result = await client.callTool({
      name: "sales_quarterly_summary",
      arguments: { groupBy: "bogus" },
    });
    expect(result.isError).toBe(true);
    const content = (result.content as { type: string; text: string }[])[0]!;
    expect(content.text).toContain("groupBy");
  });

  it("a generated intent tool call with a valid param still composes normally", async () => {
    const result = await client.callTool({
      name: "sales_quarterly_summary",
      arguments: { groupBy: "product" },
    });
    expect(result.isError).toBeFalsy();
  });

  it("kohaku_event with an unknown canonical in `intent` is a structured tool error", async () => {
    const result = await client.callTool({
      name: "kohaku_event",
      arguments: {
        intent: { canonical: "sales.bogus", params: {} },
        on: "table1.sort",
        payload: {},
      },
    });
    expect(result.isError).toBe(true);
    const content = (result.content as { type: string; text: string }[])[0]!;
    expect(content.text).toContain('unknown intent "sales.bogus"');
  });

  it("kohaku_event with an invalid param in `intent` is a structured tool error", async () => {
    const result = await client.callTool({
      name: "kohaku_event",
      arguments: {
        intent: { canonical: "sales.trend", params: { groupBy: "bogus" } },
        on: "table1.sort",
        payload: {},
      },
    });
    expect(result.isError).toBe(true);
    const content = (result.content as { type: string; text: string }[])[0]!;
    expect(content.text).toContain("groupBy");
  });

  it("kohaku_event with a valid `intent` still recomposes normally", async () => {
    const result = await client.callTool({
      name: "kohaku_event",
      arguments: {
        intent: { canonical: "sales.trend", params: { groupBy: "region" } },
        on: "table1.sort",
        payload: {},
      },
    });
    expect(result.isError).toBeFalsy();
  });
});

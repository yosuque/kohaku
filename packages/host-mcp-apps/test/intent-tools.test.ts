import type { ComposeContext } from "@kohaku-ui/composer";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import { type AuthzPort, type DomainPort, parseSpec, type Scope, type UISpec } from "@kohaku-ui/spec-core";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  attachKohakuToMcpServer,
  type IntentToolSource,
  intentToolsFromCatalog,
  RENDERER_RESOURCE_URI,
  RESOURCE_URI_META_KEY,
  toMcpToolName,
  UI_META_KEY,
  VISIBILITY_META_KEY,
} from "../src/index.js";

/** A small helper that extracts the modern (nested) form _meta.ui in a typed way. */
function uiMeta(
  meta: Record<string, unknown> | undefined,
): { resourceUri?: string; visibility?: string[] } | undefined {
  return meta?.[UI_META_KEY] as { resourceUri?: string; visibility?: string[] } | undefined;
}

const REF = "query://sales/summary?fy=2026&groupBy=region";

/** The generic view (a minimal shape imitating sample-api's IntentDef). */
const DEFS: IntentToolSource[] = [
  {
    name: "sales.quarterly_summary",
    description: "Aggregate and display the specified quarter's sales by region/product/channel",
    params: z.object({
      fiscalYear: z.coerce.number().int().min(2025).max(2026).default(2026),
      quarter: z.coerce.number().int().min(1).max(4).default(3),
      groupBy: z.enum(["region", "product", "channel"]).default("region"),
    }),
  },
  {
    name: "sales.kpi_overview",
    description: "Display this period's summary KPIs as cards",
    params: z.object({ fiscalYear: z.coerce.number().int().default(2026) }),
  },
];

describe("toMcpToolName: normalizes to MCP naming constraints", () => {
  it("collapses dots into _ (sales.quarterly_summary → sales_quarterly_summary)", () => {
    expect(toMcpToolName("sales.quarterly_summary")).toBe("sales_quarterly_summary");
  });

  it("leaves already-valid names (including _) unchanged", () => {
    expect(toMcpToolName("sales_records")).toBe("sales_records");
  });

  it("collapses consecutive unsupported chars into a single _ and drops edge _", () => {
    expect(toMcpToolName(".a..b.")).toBe("a_b");
  });

  it("adds a namespace when namePrefix is given", () => {
    expect(toMcpToolName("sales.trend", "kohaku")).toBe("kohaku_sales_trend");
  });
});

describe("intentToolsFromCatalog: catalog → intent tools", () => {
  it("normalizes canonical into the name and carries through description / paramsShape / toIntent", () => {
    const tools = intentToolsFromCatalog(DEFS);
    expect(tools.map((t) => t.name)).toEqual(["sales_quarterly_summary", "sales_kpi_overview"]);

    const summary = tools[0]!;
    expect(summary.description).toContain("quarter");
    // paramsShape is a Zod raw shape (the material the SDK converts to JSON Schema)
    expect(Object.keys(summary.paramsShape)).toEqual(["fiscalYear", "quarter", "groupBy"]);
    // toIntent keeps canonical as-is (only the tool name is normalized)
    expect(summary.toIntent({ fiscalYear: 2026 })).toEqual({
      canonical: "sales.quarterly_summary",
      params: { fiscalYear: 2026 },
    });
  });

  it("rejects Intents whose tool names collide after normalization", () => {
    const conflicting: IntentToolSource[] = [
      { name: "sales.foo", description: "a", params: z.object({}) },
      { name: "sales_foo", description: "b", params: z.object({}) },
    ];
    expect(() => intentToolsFromCatalog(conflicting)).toThrow(/collides/);
  });

  it("rejects names that become empty after normalization", () => {
    const empty: IntentToolSource[] = [{ name: "...", description: "a", params: z.object({}) }];
    expect(() => intentToolsFromCatalog(empty)).toThrow(/valid MCP tool name/);
  });
});

// --- registration / visibility / inputSchema / routing via a real MCP server ---------------

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
    semantic: {
      async normalize() {
        return { canonical: "sales.quarterly_summary", params: {}, hash: "" };
      },
      async resolveQuery() {
        return { uri: REF };
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
          // Reflect the received intent into the Spec as-is (for routing verification).
          return (intentArg, refs): UISpec => ({
            kohaku: "0.1",
            intent: intentArg,
            dataVersion: "x",
            components: [
              { id: "root", type: "layout.stack", props: {}, children: ["t"] },
              { id: "t", type: "text.heading", props: { level: 2, text: "Summary" } },
              {
                id: "c",
                type: "presentTable",
                props: {},
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

describe("generated intent tool registration / visibility / inputSchema / routing", () => {
  let client: Client;

  beforeAll(async () => {
    const server = new McpServer({ name: "kohaku-intent-tools-test", version: "0.1.0" });
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

  it("all Intents register as model-visible typed tools with resourceUri", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    for (const name of ["sales_quarterly_summary", "sales_kpi_overview"]) {
      const tool = byName.get(name);
      expect(tool, `${name} should be registered`).toBeDefined();
      // legacy (flat) form
      expect(tool!._meta?.[RESOURCE_URI_META_KEY]).toBe(RENDERER_RESOURCE_URI);
      expect(tool!._meta?.[VISIBILITY_META_KEY]).toEqual(["model"]);
      // modern (nested) form (canonical since the formalization of SEP-1865)
      expect(uiMeta(tool!._meta)).toEqual({
        resourceUri: RENDERER_RESOURCE_URI,
        visibility: ["model"],
      });
    }

    // inputSchema is generated by the SDK from the Zod params (enum / default are reflected).
    const summary = byName.get("sales_quarterly_summary")!;
    const schema = summary.inputSchema as {
      properties: Record<string, { enum?: string[]; default?: unknown }>;
    };
    expect(schema.properties["groupBy"]!.enum).toEqual(["region", "product", "channel"]);
    expect(schema.properties["fiscalYear"]!.default).toBe(2026);
  });

  it("MCP 2026-07-28 (changelog minor #3): tools/list order is deterministic — fixed tools first, then intent tools in catalog order", async () => {
    const { tools } = await client.listTools();
    // registerRendererResource registers a resource, not a tool; registration order among tools is
    // compose -> (render_snapshot, unwired in this suite) -> intent tools (catalog order) -> resolve_binding ->
    // event -> action (see server.ts's attachKohakuToMcpServer). This ordering must stay stable across
    // repeated tools/list calls and across process restarts (a Map/array registration order, not something
    // keyed by request/session), enabling client-side caching and LLM prompt-cache hits.
    expect(tools.map((t) => t.name)).toEqual([
      "kohaku_compose",
      "sales_quarterly_summary",
      "sales_kpi_overview",
      "kohaku_resolve_binding",
      "kohaku_event",
      "kohaku_action",
    ]);
    // Calling it again returns the exact same order (no per-call reshuffling).
    const again = await client.listTools();
    expect(again.tools.map((t) => t.name)).toEqual(tools.map((t) => t.name));
  });

  it("tool invocation routes to the canonical Intent and defaults are filled in", async () => {
    const result = await client.callTool({ name: "sales_kpi_overview", arguments: {} });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { spec: unknown };
    const spec = parseSpec(structured.spec);
    // toMcpToolName changes the name, but the Intent arrives still as canonical.
    expect(spec.intent.canonical).toBe("sales.kpi_overview");
    // The MCP SDK fills the Zod default before passing to the handler.
    expect(spec.intent.params["fiscalYear"]).toBe(2026);
    // The text fallback is preserved too.
    const content = (result.content as { type: string; text: string }[])[0]!;
    expect(content.type).toBe("text");
    expect(content.text.length).toBeGreaterThan(0);
  });
});

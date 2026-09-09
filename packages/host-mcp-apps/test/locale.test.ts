import type { ComposeContext, ComposePolicy } from "@kohaku-ui/composer";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type { AuthzPort, DomainPort, SessionContext, TabularData, UISpec } from "@kohaku-ui/spec-core";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { attachKohakuToMcpServer } from "../src/index.js";

// The shared `locale` tool argument: the calling LLM sets the user's language per call, and it
// rides SessionContext.locale into NL normalize, the fixation gate, and ComposeContext.policyFor —
// the same knob the REST profile carries as session.locale.

const TREND_REF = "query://sales/trend?granularity=month&metric=revenue";

const DATA: TabularData = {
  columns: [
    { key: "month", type: "string" },
    { key: "revenue", type: "number" },
  ],
  rows: [{ month: "2026-04", revenue: 100 }],
  dataVersion: "sales@seed-1",
};

const authz: AuthzPort = {
  async issueCapability() {
    return "cap";
  },
  async verify() {
    return { ok: true, principal: { id: "tester" } };
  },
};

const domain: DomainPort = {
  async listOperations() {
    return [];
  },
  async invoke() {
    return DATA;
  },
};

/** Fixed spec whose heading reveals which language policy composed it. */
function fixedSpecsFor(title: string): ComposePolicy["fixedSpecs"] {
  return {
    async lookup() {
      return (intentArg, refs): UISpec => ({
        kohaku: "0.1",
        intent: intentArg,
        dataVersion: "x",
        components: [
          { id: "root", type: "layout.stack", props: {}, children: ["t", "c"] },
          { id: "t", type: "text.heading", props: { level: 2, text: title } },
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
  };
}

/** EN/JA policy pair + policyFor, mirroring sample-api's compose-context (capturing sessions). */
function makeLangCtx(): { ctx: ComposeContext; normalizeSessions: SessionContext[] } {
  const cache = new Map<string, UISpec>();
  const normalizeSessions: SessionContext[] = [];
  const policyByLang: Record<"en" | "ja", ComposePolicy> = {
    en: { fixedSpecs: fixedSpecsFor("Monthly revenue trend"), generatorVersion: "t" },
    ja: { fixedSpecs: fixedSpecsFor("月次売上の推移"), generatorVersion: "t/ja" },
  };
  const ctx: ComposeContext = {
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
      async normalize(input, session) {
        normalizeSessions.push(session);
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
    policy: policyByLang.en,
    policyFor: (session) => policyByLang[session?.locale === "ja" ? "ja" : "en"],
  };
  return { ctx, normalizeSessions };
}

async function makeClient(
  ctx: ComposeContext,
  extras?: {
    fixationLookup?: (hash: string, session: SessionContext) => Promise<null>;
    intentTools?: Parameters<typeof attachKohakuToMcpServer>[2]["intentTools"];
  },
): Promise<Client> {
  const server = new McpServer({ name: "kohaku-test", version: "0.1.0" });
  attachKohakuToMcpServer(
    server,
    {
      compose: ctx,
      domain,
      authz,
      querySource: "sales",
      ...(extras?.fixationLookup != null ? { fixationLookup: extras.fixationLookup } : {}),
    },
    {
      rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>",
      ...(extras?.intentTools != null ? { intentTools: extras.intentTools } : {}),
    },
  );
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function headingOf(result: unknown): string {
  const spec = (result as { structuredContent: { spec: UISpec } }).structuredContent.spec;
  const heading = spec.components.find((c) => c.type === "text.heading");
  return String((heading?.props as { text?: string } | undefined)?.text ?? "");
}

describe("MCP locale tool argument", () => {
  it("kohaku_compose: locale=ja selects the JA policy; omitted stays EN; normalize sees the locale", async () => {
    const { ctx, normalizeSessions } = makeLangCtx();
    const client = await makeClient(ctx);
    const ja = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "売上の月次推移", locale: "ja" },
    });
    expect(headingOf(ja)).toBe("月次売上の推移");
    const en = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });
    expect(headingOf(en)).toBe("Monthly revenue trend");
    expect(normalizeSessions[0]).toMatchObject({ surface: "mcp-app", locale: "ja" });
    expect("locale" in normalizeSessions[1]!).toBe(false);
  });

  it("intent tools: locale is accepted, applied, and stripped from the intent params", async () => {
    const { ctx } = makeLangCtx();
    const captured: Array<Record<string, unknown>> = [];
    const client = await makeClient(ctx, {
      intentTools: [
        {
          name: "sales_trend",
          description: "trend",
          paramsShape: { metric: z.string().optional() },
          toIntent: (args) => {
            captured.push(args);
            return { canonical: "sales.trend", params: args };
          },
        },
      ],
    });
    const result = await client.callTool({
      name: "sales_trend",
      arguments: { metric: "revenue", locale: "ja" },
    });
    expect(headingOf(result)).toBe("月次売上の推移");
    // The reserved argument must not pollute the canonical intent params (intent-hash stability).
    expect(captured[0]).toEqual({ metric: "revenue" });
  });

  it("intent tools: a catalog param named locale is rejected at attach time (reserved name)", async () => {
    const { ctx } = makeLangCtx();
    const server = new McpServer({ name: "kohaku-test", version: "0.1.0" });
    expect(() =>
      attachKohakuToMcpServer(
        server,
        { compose: ctx, domain, authz, querySource: "sales" },
        {
          rendererHtml: "<html></html>",
          intentTools: [
            {
              name: "bad_tool",
              description: "declares the reserved param",
              paramsShape: { locale: z.string() },
              toIntent: (args) => ({ canonical: "x", params: args }),
            },
          ],
        },
      ),
    ).toThrow(/reserved/);
  });

  it("kohaku_event: locale reaches the normalize session and the recompose policy", async () => {
    const { ctx, normalizeSessions } = makeLangCtx();
    const client = await makeClient(ctx);
    const result = await client.callTool({
      name: "kohaku_event",
      arguments: {
        intent: { canonical: "sales.trend", params: {} },
        on: "c.pointClick",
        payload: {},
        locale: "ja",
      },
    });
    expect(headingOf(result)).toBe("月次売上の推移");
    expect(normalizeSessions[0]).toMatchObject({ surface: "mcp-app", locale: "ja" });
  });

  it("fixationLookup receives the per-call session (so products can gate by language)", async () => {
    const { ctx } = makeLangCtx();
    const seen: SessionContext[] = [];
    const client = await makeClient(ctx, {
      fixationLookup: async (_hash, session) => {
        seen.push(session);
        return null;
      },
    });
    await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "売上の月次推移", locale: "ja" },
    });
    expect(seen[0]).toMatchObject({ surface: "mcp-app", locale: "ja" });
  });
});

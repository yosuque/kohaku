import {
  createHmacApprovalPort,
  createHmacAuthzPort,
  createMemoryApprovalStore,
} from "@kohaku-ui/authz-hmac";
import { createKohakuHost, type KohakuHost } from "@kohaku-ui/host";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import {
  actionPayloadHash,
  type LineageEventRecord,
  type TabularData,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMcpIntents } from "../src/intents.js";
import { createMcpDomainPort } from "../src/port.js";

const SECRET = "e2e-secret-of-decent-length";
const SOURCE = "orders";
const OPEN_REF = "query://orders/list_orders?status=open";

const ORDERS = [
  { id: "o-1", status: "open", total: 10, placedAt: "2026-04-01" },
  { id: "o-2", status: "paid", total: 20, placedAt: "2026-04-02" },
  { id: "o-3", status: "open", total: 30, placedAt: "2026-04-03" },
];

/** The "existing MCP server": one read-only tool and one write tool, nothing kohaku-specific about it. */
function buildUpstream(refunds: { orderId: string; amount?: number }[]): McpServer {
  const server = new McpServer({ name: "orders-upstream", version: "0.0.1" });
  server.registerTool(
    "list_orders",
    {
      description: "List orders, optionally by status",
      inputSchema: z.object({
        status: z.enum(["open", "paid"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      outputSchema: z.object({
        rows: z.array(
          z.object({
            id: z.string(),
            status: z.string(),
            total: z.number(),
            placedAt: z.string().describe("date"),
          }),
        ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ status, limit }) => {
      const rows = ORDERS.filter((o) => status == null || o.status === status).slice(0, limit ?? 100);
      return { content: [{ type: "text", text: JSON.stringify({ rows }) }], structuredContent: { rows } };
    },
  );
  server.registerTool(
    "refund_order",
    {
      description: "Refund an order",
      inputSchema: z.object({ orderId: z.string(), amount: z.number().min(0).optional() }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ orderId, amount }) => {
      refunds.push({ orderId, ...(amount != null ? { amount } : {}) });
      const structured = { refunded: true, orderId };
      return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
    },
  );
  return server;
}

async function connectUpstream(refunds: { orderId: string; amount?: number }[]) {
  const handler = createMcpHandler(() => buildUpstream(refunds));
  const client = new Client(
    { name: "kohaku-domain-mcp-e2e", version: "0.0.1" },
    { versionNegotiation: { mode: "auto" } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://in-process.domain-mcp-e2e.invalid/mcp"), {
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

/** The raw-format L1 draft FakeLlm hands the composer: a heading and a chart bound to the open-orders ref. */
function ordersDraft(): unknown {
  return {
    components: [
      { id: "root", type: "layout.stack", props: { direction: "vertical", gap: null }, children: ["h", "c"] },
      { id: "h", type: "text.heading", props: { level: 2, text: "Open orders" } },
      {
        id: "c",
        type: "presentChart",
        props: { kind: "bar", x: "id", y: "total", series: null, stacked: null, title: null },
        children: null,
        data: { $ref: OPEN_REF },
      },
    ],
    events: [],
  };
}

async function setup() {
  const refunds: { orderId: string; amount?: number }[] = [];
  const upstream = await connectUpstream(refunds);
  const skipped: unknown[] = [];
  const projections: unknown[] = [];
  const port = await createMcpDomainPort({
    client: upstream.client,
    onSkip: (report) => skipped.push(report),
    onSchemaProjection: (report) => projections.push(report),
  });
  const intents = createMcpIntents(port, { source: SOURCE });
  const authz = createHmacAuthzPort(SECRET);
  const approvals = createHmacApprovalPort(SECRET, { store: createMemoryApprovalStore() });
  const llm = new FakeLlm({ objects: [ordersDraft()] });
  const host = createKohakuHost({
    domain: port,
    querySource: SOURCE,
    llm,
    intents,
    describeShape: (ref) => port.describeShape(ref),
    // The port stamps the data with this very function, so the Spec's version and the data's never disagree.
    dataVersion: port.dataVersion,
    authz,
    routes: {
      approvals,
      // Principals by header; only the "approver" principal may mint approvals.
      auth: async (c) => ({ id: c.req.header("x-user") ?? "anonymous", roles: [] }),
      authorizeGovernance: (principal, operation) =>
        operation.kind === "action.approve" && principal.id === "approver",
    },
    policy: { allowL2: false },
  });
  return { host, port, authz, llm, refunds, skipped, projections, close: upstream.close };
}

async function postJson(
  app: KohakuHost["app"],
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(`/api/kohaku${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("domain-mcp end to end (upstream MCP server -> createKohakuHost)", () => {
  it("exposes the read-only tool as an Intent and the write tool as an approve-tier Action", async () => {
    const ctx = await setup();
    try {
      expect([...ctx.port.queryOps]).toEqual(["list_orders"]);
      expect([...ctx.port.actionOps]).toEqual(["refund_order"]);
      const ops = await ctx.port.listOperations();
      expect(ops.find((op) => op.name === "refund_order")).toMatchObject({
        tier: "approve",
        paramsSchema: {
          type: "object",
          properties: { orderId: { type: "string" }, amount: { type: "number", minimum: 0 } },
          required: ["orderId"],
          additionalProperties: false,
        },
      });
      expect(ctx.skipped).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  it("composes a view over the read tool and resolves its rows through /binding/resolve", async () => {
    const ctx = await setup();
    try {
      const res = await postJson(ctx.host.app, "/compose", {
        input: {
          kind: "gui",
          action: "view.select",
          params: { intent: "orders.list_orders", status: "open" },
        },
      });
      expect(res.status).toBe(200);
      const { spec, capability } = (await res.json()) as { spec: UISpec; capability: string };
      expect(spec.provenance.tier).toBe("L1");
      expect(spec.dataVersion).toMatch(/^mcp:\d+$/);
      expect(spec.components.find((c) => c.type === "presentChart")?.data?.$ref).toBe(OPEN_REF);

      const dataRes = await ctx.host.app.request(
        `/api/kohaku/binding/resolve?ref=${encodeURIComponent(OPEN_REF)}`,
        { headers: { authorization: `Bearer ${capability}` } },
      );
      expect(dataRes.status).toBe(200);
      const data = (await dataRes.json()) as TabularData;
      expect(data.rows.map((r) => r["id"])).toEqual(["o-1", "o-3"]);
      expect(data.columns.map((c) => c.key)).toEqual(["id", "status", "total", "placedAt"]);
      expect(data.dataVersion).toBe(spec.dataVersion);
    } finally {
      await ctx.close();
    }
  });

  it("gates the write tool behind an approval token and records the trail", async () => {
    const ctx = await setup();
    try {
      const requesterCap = await ctx.authz.issueCapability({ id: "requester", roles: [] }, [
        { kind: "write", ref: "refund_order" },
      ]);
      const payload = { orderId: "o-1", amount: 5 };
      const attempt = (approval?: string) =>
        postJson(
          ctx.host.app,
          "/binding/action",
          { action: "refund_order", payload, ...(approval != null ? { approval } : {}) },
          { authorization: `Bearer ${requesterCap}` },
        );

      const refused = await attempt();
      expect(refused.status).toBe(403);
      const refusedBody = (await refused.json()) as { error: { code: string; approval: { tier: string } } };
      expect(refusedBody.error.code).toBe("APPROVAL_REQUIRED");
      expect(refusedBody.error.approval.tier).toBe("approve");
      expect(ctx.refunds).toEqual([]);

      // A payload the projected schema forbids is refused before the approval gate (422), never reaching the server.
      const invalid = await postJson(
        ctx.host.app,
        "/binding/action",
        { action: "refund_order", payload: { orderId: "o-1", extra: true } },
        { authorization: `Bearer ${requesterCap}` },
      );
      expect(invalid.status).toBe(422);

      const approve = await postJson(
        ctx.host.app,
        "/approvals",
        { action: "refund_order", payloadHash: await actionPayloadHash(payload), requesterId: "requester" },
        { "x-user": "approver" },
      );
      expect(approve.status).toBe(200);
      const { approval } = (await approve.json()) as { approval: string };

      const approved = await attempt(approval);
      expect(approved.status).toBe(200);
      expect(((await approved.json()) as { result: unknown }).result).toEqual({
        refunded: true,
        orderId: "o-1",
      });
      expect(ctx.refunds).toEqual([{ orderId: "o-1", amount: 5 }]);

      const events = async (type: string) =>
        (await ctx.host.lineage.list({ type: [type as LineageEventRecord["type"]] })).length;
      expect(await events("action.approvalRequested")).toBe(1);
      expect(await events("action.approved")).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  it("never lets a write tool be read: a ref to refund_order has no capability to resolve it", async () => {
    const ctx = await setup();
    try {
      const composed = await postJson(ctx.host.app, "/compose", {
        input: { kind: "gui", action: "view.select", params: { intent: "orders.list_orders" } },
      });
      const { capability } = (await composed.json()) as { capability: string };
      const res = await ctx.host.app.request(
        `/api/kohaku/binding/resolve?ref=${encodeURIComponent("query://orders/refund_order?orderId=o-1")}`,
        { headers: { authorization: `Bearer ${capability}` } },
      );
      expect(res.status).toBe(403);
      expect(ctx.refunds).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});

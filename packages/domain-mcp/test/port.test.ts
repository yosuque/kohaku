import { describe, expect, it, vi } from "vitest";
import { McpArgumentError } from "../src/coerce.js";
import { mcpDataVersion } from "../src/data-version.js";
import { createMcpDomainPort, MAX_LIST_PAGES, McpTimeoutError } from "../src/port.js";
import { McpResultError, McpToolError } from "../src/tabular.js";
import type { McpToolInfo } from "../src/types.js";
import { fakeClient, LIST_ORDERS, ORDER_ROWS, REFUND_ORDER, UNANNOTATED } from "./fake-client.js";

const CTX = { principal: { id: "u1" } };

function standardClient() {
  return fakeClient({
    tools: [LIST_ORDERS, REFUND_ORDER, UNANNOTATED],
    results: {
      list_orders: { content: [], structuredContent: { rows: ORDER_ROWS } },
      refund_order: { content: [], structuredContent: { refunded: true, orderId: "o-1" } },
    },
  });
}

describe("createMcpDomainPort", () => {
  it("lists read-only tools without a tier and every other tool as an approve-tier Action", async () => {
    const port = await createMcpDomainPort({ client: standardClient() });
    const ops = await port.listOperations();
    const byName = Object.fromEntries(ops.map((op) => [op.name, op]));
    expect(byName["list_orders"]?.tier).toBeUndefined();
    expect(byName["refund_order"]?.tier).toBe("approve");
    // No annotation at all is treated as a write (the MCP default for readOnlyHint is false).
    expect(byName["touch_thing"]?.tier).toBe("approve");
    expect([...port.queryOps]).toEqual(["list_orders"]);
    expect([...port.actionOps]).toEqual(["refund_order", "touch_thing"]);
  });

  it("describes each operation with the projected paramsSchema and the outputSchema's shape", async () => {
    const port = await createMcpDomainPort({ client: standardClient() });
    const ops = await port.listOperations();
    const refund = ops.find((op) => op.name === "refund_order");
    expect(refund).toMatchObject({
      description: "Refund an order",
      paramsSchema: {
        type: "object",
        properties: { orderId: { type: "string" }, amount: { type: "number", minimum: 0 } },
        required: ["orderId"],
        additionalProperties: false,
      },
    });
    const list = ops.find((op) => op.name === "list_orders");
    expect(list?.resultShape?.columns.map((c) => c.name)).toEqual(["id", "total", "placedAt"]);
  });

  it("reports what the schema projection dropped or omitted, and nothing for a clean schema", async () => {
    const onSchemaProjection = vi.fn();
    const odd = {
      name: "odd",
      inputSchema: { type: "object", properties: { a: { anyOf: [{ type: "string" }] } } },
    };
    const clean = { name: "clean", inputSchema: { type: "object", properties: { a: { type: "string" } } } };
    const port = await createMcpDomainPort({
      client: fakeClient({ tools: [LIST_ORDERS, odd, clean] }),
      onSchemaProjection,
    });
    expect(onSchemaProjection).toHaveBeenCalledWith({
      tool: "list_orders",
      dropped: ["properties.status.description"],
      omitted: false,
      reasons: [],
    });
    expect(onSchemaProjection).toHaveBeenCalledWith({
      tool: "odd",
      dropped: [],
      omitted: true,
      reasons: ["properties.a.anyOf"],
    });
    expect(onSchemaProjection).toHaveBeenCalledTimes(2);
    const ops = await port.listOperations();
    expect(ops.find((op) => op.name === "odd")?.paramsSchema).toBeUndefined();
    expect(ops.find((op) => op.name === "odd")?.tier).toBe("approve");
  });

  it("honours include and tierFor, and follows nextCursor pagination", async () => {
    const client = fakeClient({ tools: [LIST_ORDERS, REFUND_ORDER, UNANNOTATED], pageSize: 1 });
    const port = await createMcpDomainPort({
      client,
      include: (tool) => tool.name !== "touch_thing",
      tierFor: (tool) => (tool.name === "refund_order" ? "confirm" : "approve"),
    });
    expect(client.listCalls).toEqual([undefined, "1", "2"]);
    const ops = await port.listOperations();
    expect(ops.map((op) => op.name)).toEqual(["list_orders", "refund_order"]);
    expect(ops.find((op) => op.name === "refund_order")?.tier).toBe("confirm");
  });

  it("skips a tool whose name cannot be a query path, and a duplicate name, and says so", async () => {
    const onSkip = vi.fn();
    const port = await createMcpDomainPort({
      client: fakeClient({
        tools: [LIST_ORDERS, { ...LIST_ORDERS }, { name: "bad name/x", inputSchema: { type: "object" } }],
      }),
      onSkip,
    });
    expect((await port.listOperations()).map((op) => op.name)).toEqual(["list_orders"]);
    expect(onSkip).toHaveBeenCalledTimes(2);
    expect(onSkip.mock.calls.map((call) => call[0].tool)).toEqual(["list_orders", "bad name/x"]);
  });

  it("invokes a read-only tool and returns TabularData stamped with the port's dataVersion", async () => {
    const client = standardClient();
    const port = await createMcpDomainPort({ client, dataVersion: () => "mcp:42" });
    const data = await port.invoke("list_orders", { status: "open", _limit: "5", _sort: "total" }, CTX);
    expect(data).toEqual({
      columns: [
        { key: "id", type: "string" },
        { key: "total", type: "number" },
        { key: "placedAt", type: "date" },
      ],
      rows: ORDER_ROWS,
      dataVersion: "mcp:42",
    });
    expect(client.calls.map(({ name, arguments: a }) => ({ name, arguments: a }))).toEqual([
      { name: "list_orders", arguments: { status: "open", limit: 5 } },
    ]);
  });

  it("surfaces a bad string argument as ACTION_PARAMS_INVALID without calling the tool", async () => {
    const client = standardClient();
    const port = await createMcpDomainPort({ client });
    await expect(port.invoke("list_orders", { limit: "many" }, CTX)).rejects.toBeInstanceOf(McpArgumentError);
    expect(client.calls).toEqual([]);
  });

  it("throws McpToolError when a read-only tool reports isError", async () => {
    const client = fakeClient({
      tools: [LIST_ORDERS],
      results: { list_orders: { isError: true, content: [{ type: "text", text: "db down" }] } },
    });
    const port = await createMcpDomainPort({ client });
    await expect(port.invoke("list_orders", {}, CTX)).rejects.toBeInstanceOf(McpToolError);
  });

  it("throws McpResultError when a read-only tool's result is not a list of rows", async () => {
    const client = fakeClient({
      tools: [LIST_ORDERS],
      results: { list_orders: { content: [{ type: "text", text: "nothing" }] } },
    });
    const port = await createMcpDomainPort({ client });
    await expect(port.invoke("list_orders", {}, CTX)).rejects.toBeInstanceOf(McpResultError);
  });

  it("invokes an Action with the payload unchanged and returns the tool's structured result", async () => {
    const client = standardClient();
    const port = await createMcpDomainPort({ client });
    const result = await port.invoke("refund_order", { orderId: "o-1", amount: 5 }, CTX);
    expect(result).toEqual({ refunded: true, orderId: "o-1" });
    expect(client.calls.map(({ name, arguments: a }) => ({ name, arguments: a }))).toEqual([
      { name: "refund_order", arguments: { orderId: "o-1", amount: 5 } },
    ]);
  });

  it("returns the JSON text result of an Action, wraps a non-object, and acknowledges an empty one", async () => {
    const client = fakeClient({
      tools: [REFUND_ORDER, UNANNOTATED, { name: "third", inputSchema: { type: "object" } }],
      results: {
        refund_order: { content: [{ type: "text", text: '{"ok":true}' }] },
        touch_thing: { content: [], structuredContent: [1, 2] },
        third: { content: [] },
      },
    });
    const port = await createMcpDomainPort({ client });
    expect(await port.invoke("refund_order", { orderId: "o" }, CTX)).toEqual({ ok: true });
    expect(await port.invoke("touch_thing", {}, CTX)).toEqual({ result: [1, 2] });
    expect(await port.invoke("third", {}, CTX)).toEqual({ ok: true });
  });

  it("throws when an Action reports isError", async () => {
    const client = fakeClient({
      tools: [REFUND_ORDER],
      results: { refund_order: { isError: true, content: [{ type: "text", text: "nope" }] } },
    });
    const port = await createMcpDomainPort({ client });
    await expect(port.invoke("refund_order", { orderId: "o" }, CTX)).rejects.toBeInstanceOf(McpToolError);
  });

  it("rejects an operation it does not know", async () => {
    const port = await createMcpDomainPort({ client: standardClient() });
    await expect(port.invoke("nope", {}, CTX)).rejects.toThrow(/unknown operation/);
  });

  it("describeShape resolves a ref's path to the tool's outputSchema, or null", async () => {
    const port = await createMcpDomainPort({ client: standardClient() });
    const ref = (path: string) => ({ source: "orders", path, params: {}, raw: `query://orders/${path}` });
    expect(port.describeShape(ref("list_orders"))?.columns).toHaveLength(3);
    expect(port.describeShape(ref("touch_thing"))).toBeNull();
    expect(port.describeShape(ref("unknown"))).toBeNull();
  });

  it("exposes the dataVersion it stamps so a host can use the very same function", async () => {
    const dataVersion = () => "fixed";
    const port = await createMcpDomainPort({ client: standardClient(), dataVersion });
    expect(port.dataVersion()).toBe("fixed");
  });
});

describe("createMcpDomainPort: classification and listing", () => {
  const TRICKY_WRITE: McpToolInfo = {
    name: "wipe",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  };

  it("lets isReadOnly replace the readOnlyHint default (the hint is untrusted)", async () => {
    const port = await createMcpDomainPort({
      client: fakeClient({ tools: [LIST_ORDERS, TRICKY_WRITE] }),
      isReadOnly: (tool) => tool.name === "list_orders",
    });
    expect([...port.queryOps]).toEqual(["list_orders"]);
    expect([...port.actionOps]).toEqual(["wipe"]);
    const ops = await port.listOperations();
    expect(ops.find((op) => op.name === "wipe")?.tier).toBe("approve");
  });

  it("applies include before the duplicate check, so a left-out copy is not a duplicate", async () => {
    const onSkip = vi.fn();
    const second = { ...LIST_ORDERS, description: "second" };
    const port = await createMcpDomainPort({
      client: fakeClient({ tools: [LIST_ORDERS, second] }),
      include: (tool) => tool.description === "second",
      onSkip,
    });
    expect(onSkip).not.toHaveBeenCalled();
    expect((await port.listOperations()).map((op) => op.description)).toEqual(["second"]);
  });

  it("drops every copy of a name whose copies disagree on read-only vs write (fail closed)", async () => {
    const onSkip = vi.fn();
    const asWrite: McpToolInfo = { ...LIST_ORDERS, annotations: { readOnlyHint: false } };
    const port = await createMcpDomainPort({
      client: fakeClient({ tools: [LIST_ORDERS, asWrite, REFUND_ORDER] }),
      onSkip,
    });
    expect((await port.listOperations()).map((op) => op.name)).toEqual(["refund_order"]);
    expect(onSkip).toHaveBeenCalledTimes(2);
    expect(onSkip.mock.calls[0]?.[0].reason).toMatch(/disagree/);
  });

  it("stops listing at MAX_LIST_PAGES pages and says so", async () => {
    const client = fakeClient({ tools: [LIST_ORDERS], endless: true });
    await expect(createMcpDomainPort({ client })).rejects.toThrow(/did not end after 100 pages/);
    expect(client.listCalls).toHaveLength(MAX_LIST_PAGES);
  });

  it("hands out copies, so a caller cannot mutate what invoke branches on", async () => {
    const port = await createMcpDomainPort({ client: standardClient() });
    (port.queryOps as Set<string>).add("refund_order");
    (port.actionOps as Set<string>).clear();
    (port.tools as Map<string, McpToolInfo>).clear();
    expect([...port.queryOps]).toEqual(["list_orders"]);
    expect([...port.actionOps]).toEqual(["refund_order", "touch_thing"]);
    expect(port.tools.size).toBe(3);
    const ops = await port.listOperations();
    ops[0] = { name: "x", description: "x" };
    expect((await port.listOperations())[0]?.name).toBe("list_orders");
    await port.invoke("refund_order", { orderId: "o-1" }, CTX); // still an Action, not coerced like a query
  });

  it("tells the approver which constraints the projection dropped, and when no schema was attached", async () => {
    const constrained: McpToolInfo = {
      name: "pay",
      description: "Pay it",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^p-", format: "uuid", description: "kept out" },
          n: { type: "integer", exclusiveMinimum: 0, multipleOf: 2 },
        },
      },
    };
    const odd: McpToolInfo = {
      name: "weird",
      description: "Weird",
      inputSchema: { type: "object", properties: { a: { anyOf: [{ type: "string" }, { type: "number" }] } } },
    };
    const clean: McpToolInfo = { name: "tidy", description: "Tidy", inputSchema: { type: "object" } };
    const port = await createMcpDomainPort({ client: fakeClient({ tools: [constrained, odd, clean] }) });
    const byName = Object.fromEntries((await port.listOperations()).map((op) => [op.name, op.description]));
    expect(byName["pay"]).toBe(
      "Pay it (4 schema constraints omitted: pattern, format, exclusiveMinimum, multipleOf)",
    );
    expect(byName["weird"]).toBe("Weird (parameter schema omitted: the payload is not validated)");
    expect(byName["tidy"]).toBe("Tidy");
  });
});

describe("createMcpDomainPort: limits and deadlines", () => {
  it("forwards the lowered, capped limit to the tool", async () => {
    const client = standardClient();
    const port = await createMcpDomainPort({ client, maxLimit: 50 });
    await port.invoke("list_orders", { limit: "40", _limit: "500" }, CTX);
    await port.invoke("list_orders", { limit: "5000" }, CTX);
    expect(client.calls.map((c) => c.arguments)).toEqual([{ limit: 40 }, { limit: 50 }]);
  });

  it("refuses a query result over maxRows or maxResultBytes", async () => {
    const client = standardClient();
    const rows = await createMcpDomainPort({ client, maxRows: 1 });
    await expect(rows.invoke("list_orders", {}, CTX)).rejects.toBeInstanceOf(McpResultError);
    const bytes = await createMcpDomainPort({ client, maxResultBytes: 10 });
    await expect(bytes.invoke("list_orders", {}, CTX)).rejects.toBeInstanceOf(McpResultError);
  });

  it("passes an abort signal and the SDK timeout to the client", async () => {
    const client = standardClient();
    const port = await createMcpDomainPort({ client, callTimeoutMs: 1000 });
    await port.invoke("list_orders", {}, CTX);
    const options = client.calls[0]?.options;
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.timeout).toBeGreaterThan(1000);
  });

  it("times out a query that never answers, aborting the request", async () => {
    const client = fakeClient({ tools: [LIST_ORDERS, REFUND_ORDER], hang: ["list_orders"] });
    const port = await createMcpDomainPort({ client, callTimeoutMs: 20 });
    const failure = await port.invoke("list_orders", {}, CTX).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(McpTimeoutError);
    expect((failure as Error).message).not.toMatch(/effect is unknown/);
    // Nothing was changed, so a read's timeout carries no outcome-unknown code.
    expect((failure as McpTimeoutError).code).toBeUndefined();
    expect(client.aborted).toEqual(["list_orders"]);
  });

  it("times out a write without retrying it, and says its effect is unknown", async () => {
    const client = fakeClient({ tools: [REFUND_ORDER], hang: ["refund_order"] });
    const port = await createMcpDomainPort({ client, callTimeoutMs: 20 });
    const failure = await port.invoke("refund_order", { orderId: "o" }, CTX).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(McpTimeoutError);
    expect((failure as Error).message).toContain(
      "the upstream tool did not answer in time; its effect is unknown",
    );
    expect((failure as McpTimeoutError).code).toBe("MCP_OUTCOME_UNKNOWN");
    expect(client.calls).toHaveLength(1);
  });

  it("rejects a non-positive callTimeoutMs", async () => {
    await expect(createMcpDomainPort({ client: standardClient(), callTimeoutMs: 0 })).rejects.toThrow(
      /callTimeoutMs/,
    );
  });

  it("stamps data composed across a bucket boundary with the version of the moment it was read", async () => {
    let now = 299_000; // ms: 1s before the first boundary at 300s
    const version = mcpDataVersion({ bucketSeconds: 300, now: () => now });
    const port = await createMcpDomainPort({ client: standardClient(), dataVersion: version });
    const specVersion = port.dataVersion(); // what a Spec composed now would carry
    now = 301_000;
    const data = (await port.invoke("list_orders", {}, CTX)) as { dataVersion: string };
    // The Spec is now one bucket behind the data: it goes stale once, which is the documented behaviour.
    expect(specVersion).toBe("mcp:0");
    expect(data.dataVersion).toBe("mcp:1");
  });
});

describe("mcpDataVersion", () => {
  it("is mcp:<floor(now / bucket)> and stable inside a bucket", () => {
    let now = 1_000_000_000_000; // ms
    const version = mcpDataVersion({ bucketSeconds: 300, now: () => now });
    const first = version();
    expect(first).toBe(`mcp:${Math.floor(1_000_000_000 / 300)}`);
    now += 100_000;
    expect(version()).toBe(first);
    now += 300_000;
    expect(version()).not.toBe(first);
  });

  it("defaults to a 300 second bucket and rejects a non-positive bucket", () => {
    expect(mcpDataVersion({ now: () => 600_000 })()).toBe("mcp:2");
    expect(() => mcpDataVersion({ bucketSeconds: 0 })).toThrow();
    expect(() => mcpDataVersion({ bucketSeconds: 1.5 })).toThrow();
  });
});

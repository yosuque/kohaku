import { describe, expect, it, vi } from "vitest";
import { createMcpIntents } from "../src/intents.js";
import { createMcpDomainPort } from "../src/port.js";
import { fakeClient, LIST_ORDERS, REFUND_ORDER } from "./fake-client.js";

describe("createMcpIntents", () => {
  it("makes one Intent per read-only tool and none for an Action", async () => {
    const port = await createMcpDomainPort({ client: fakeClient({ tools: [LIST_ORDERS, REFUND_ORDER] }) });
    const intents = createMcpIntents(port, { source: "orders" });
    expect(intents.map((intent) => intent.name)).toEqual(["orders.list_orders"]);
    expect(intents[0]?.description).toBe("List orders");
  });

  it("derives the params from the inputSchema and resolves them to a query ref on the tool", async () => {
    const port = await createMcpDomainPort({ client: fakeClient({ tools: [LIST_ORDERS] }) });
    const [intent] = createMcpIntents(port, { source: "orders" });
    expect(intent).toBeDefined();
    // Every parameter is optional here, and a string is coerced to the declared number type.
    expect(intent?.params.parse({ status: "open", limit: "5" })).toEqual({ status: "open", limit: 5 });
    expect(intent?.params.parse({})).toEqual({});
    expect(() => intent?.params.parse({ status: "bogus" })).toThrow();
    expect(() => intent?.params.parse({ limit: 0 })).toThrow();
    expect(intent?.toQueries({ status: "open", limit: 5 })).toEqual([
      { uri: "query://orders/list_orders?limit=5&status=open" },
    ]);
    expect(intent?.toQueries({})).toEqual([{ uri: "query://orders/list_orders" }]);
  });

  it("requires the inputSchema's required parameters", async () => {
    const tool = {
      name: "search",
      description: "Search",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      annotations: { readOnlyHint: true },
    };
    const port = await createMcpDomainPort({ client: fakeClient({ tools: [tool] }) });
    const [intent] = createMcpIntents(port, { source: "docs" });
    expect(() => intent?.params.parse({})).toThrow();
    expect(intent?.params.parse({ q: "x" })).toEqual({ q: "x" });
  });

  it("leaves out an optional parameter of an unsupported type, and skips a tool that requires one", async () => {
    const onSkip = vi.fn();
    const withOptional = {
      name: "a",
      inputSchema: { type: "object", properties: { n: { type: "number" }, flag: { type: "boolean" } } },
      annotations: { readOnlyHint: true },
    };
    const withRequired = {
      name: "b",
      inputSchema: { type: "object", properties: { ids: { type: "array" } }, required: ["ids"] },
      annotations: { readOnlyHint: true },
    };
    const port = await createMcpDomainPort({ client: fakeClient({ tools: [withOptional, withRequired] }) });
    const intents = createMcpIntents(port, { source: "x", onSkip });
    expect(intents.map((intent) => intent.name)).toEqual(["x.a"]);
    expect(Object.keys(intents[0]?.params.shape ?? {})).toEqual(["n"]);
    expect(onSkip).toHaveBeenCalledWith({ tool: "b", reason: expect.stringContaining("ids") });
  });

  it("reads a parameter through a nullable anyOf (how Pydantic writes Optional[...])", async () => {
    const tool = {
      name: "find",
      inputSchema: {
        type: "object",
        properties: {
          limit: { anyOf: [{ type: "integer" }, { type: "null" }], default: null },
          kind: { anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }] },
          odd: { anyOf: [{ type: "integer" }, { type: "string" }] },
        },
      },
      annotations: { readOnlyHint: true },
    };
    const port = await createMcpDomainPort({ client: fakeClient({ tools: [tool] }) });
    const [intent] = createMcpIntents(port, { source: "x" });
    // `odd` is a genuine union, not an optional: it stays out of the Intent.
    expect(Object.keys(intent?.params.shape ?? {})).toEqual(["limit", "kind"]);
    expect(intent?.params.parse({ limit: "3", kind: "a" })).toEqual({ limit: 3, kind: "a" });
    expect(() => intent?.params.parse({ kind: "zzz" })).toThrow();
  });

  it("derives a canonical name from the tool name, and refuses two tools that map to the same one", async () => {
    const make = (name: string) => ({
      name,
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    });
    const port = await createMcpDomainPort({
      client: fakeClient({ tools: [make("Get-Orders"), make("9lives")] }),
    });
    expect(createMcpIntents(port, { source: "orders" }).map((intent) => intent.name)).toEqual([
      "orders.get_orders",
      "orders.t_9lives",
    ]);
    const clash = await createMcpDomainPort({ client: fakeClient({ tools: [make("a-b"), make("a_b")] }) });
    expect(() => createMcpIntents(clash, { source: "orders" })).toThrow(/same canonical/);
  });

  it("rejects a source that cannot prefix a canonical name", async () => {
    const port = await createMcpDomainPort({ client: fakeClient({ tools: [] }) });
    expect(() => createMcpIntents(port, { source: "Bad Source" })).toThrow(/source/);
  });
});

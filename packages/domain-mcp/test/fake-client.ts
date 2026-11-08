import type { McpCallResult, McpToolClientLike, McpToolInfo } from "../src/types.js";

export interface RecordedCall {
  name: string;
  arguments?: Record<string, unknown>;
}

/** A scripted MCP client: fixed tool list (optionally paged) and per-tool results. */
export function fakeClient(options: {
  tools: McpToolInfo[];
  results?: Record<string, McpCallResult>;
  pageSize?: number;
}): McpToolClientLike & { calls: RecordedCall[]; listCalls: (string | undefined)[] } {
  const calls: RecordedCall[] = [];
  const listCalls: (string | undefined)[] = [];
  const pageSize = options.pageSize ?? options.tools.length;
  return {
    calls,
    listCalls,
    async listTools(params) {
      listCalls.push(params?.cursor);
      const start = params?.cursor == null ? 0 : Number(params.cursor);
      const end = start + pageSize;
      const page = options.tools.slice(start, end);
      return end < options.tools.length ? { tools: page, nextCursor: String(end) } : { tools: page };
    },
    async callTool(params) {
      calls.push({ name: params.name, ...(params.arguments != null ? { arguments: params.arguments } : {}) });
      const result = options.results?.[params.name];
      if (result == null) throw new Error(`no scripted result for ${params.name}`);
      return result;
    },
  };
}

export const LIST_ORDERS: McpToolInfo = {
  name: "list_orders",
  description: "List orders",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["open", "paid"], description: "Order status" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      rows: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            total: { type: "number" },
            placedAt: { type: "string", format: "date" },
          },
        },
      },
    },
  },
  annotations: { readOnlyHint: true },
};

export const REFUND_ORDER: McpToolInfo = {
  name: "refund_order",
  description: "Refund an order",
  inputSchema: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "Order id" },
      amount: { type: "number", minimum: 0 },
    },
    required: ["orderId"],
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
};

export const UNANNOTATED: McpToolInfo = {
  name: "touch_thing",
  inputSchema: { type: "object", properties: {} },
};

export const ORDER_ROWS = [
  { id: "o-1", total: 10, placedAt: "2026-04-01" },
  { id: "o-2", total: 20, placedAt: "2026-04-02" },
];

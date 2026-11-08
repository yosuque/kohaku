/**
 * The slice of an MCP `Tool` this package reads. Structural on purpose (the package never imports the MCP SDK at
 * runtime): `@modelcontextprotocol/client`'s `Tool` is assignable to it.
 */
export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  outputSchema?: { [key: string]: unknown };
  annotations?: { title?: string; readOnlyHint?: boolean; [key: string]: unknown };
}

/** The slice of an MCP `CallToolResult` this package reads. */
export interface McpCallResult {
  content?: { type: string; text?: string; [key: string]: unknown }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * Per-call options, in the shape of the MCP SDK's `RequestOptions` (`@modelcontextprotocol/client`'s
 * `callTool(params, options)`): `signal` aborts the request, `timeout` is the SDK's own deadline in milliseconds.
 */
export interface McpCallOptions {
  signal?: AbortSignal;
  timeout?: number;
}

/**
 * The slice of the MCP client this package calls: `@modelcontextprotocol/client`'s `Client` satisfies it, and so
 * does any fake with these two methods. This package never imports the SDK; bring your own connected client.
 */
export interface McpToolClientLike {
  listTools(params?: { cursor?: string }): Promise<{ tools: McpToolInfo[]; nextCursor?: string }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    options?: McpCallOptions,
  ): Promise<McpCallResult>;
}

/**
 * Shared test-only helpers for exercising the SDK v2 modern (2026-07-28) wire era in-process. Not a
 * `*.test.ts` file, so vitest's default include pattern does not pick it up as its own suite — import it
 * from the actual test files that need it.
 */

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";

/**
 * Connects a Client to a freshly built McpServer via SDK v2's stateless HTTP entry (`createMcpHandler`),
 * routed through an in-process `fetch` bridge (`handler.fetch(new Request(...))`) rather than a real TCP
 * socket — no `node:http` server, no port.
 *
 * This is deliberately NOT `InMemoryTransport.createLinkedPair()` (the pattern most of this package's tests
 * use). `InMemoryTransport` never supplies the SDK's own per-request era classification (`extra.classification`,
 * populated from HTTP headers / the `_meta` envelope claim on a real transport), so on this SDK version a
 * hand-constructed `new McpServer().connect(inMemoryTransport)` can never get past the legacy (2025-11-25)
 * bootstrap handshake — `server/discover` (the modern probe) is dispatched only once classification marks an
 * exchange modern, and no `supportedProtocolVersions` value fixes that (verified empirically: even with
 * `supportedProtocolVersions: ["2026-07-28"]`, `server/discover` over an `InMemoryTransport` pair still
 * answers `-32601 Method not found`). `createMcpHandler` is the SDK's classification-aware per-exchange entry
 * point — the exact one `apps/sample-mcp/src/http.ts`'s `createMcpHttpServer` wraps with `toNodeHandler` for
 * real HTTP — so bridging it via a custom `fetch` (skipping only the TCP socket, not the classification
 * logic) reaches the same modern era a real HTTP client negotiates in production, without this package's
 * tests needing `node:http` or a listening port.
 *
 * Originally written for the MCP 2026-07-28 response-caching work (SEP-2549's `ttlMs`/`cacheScope` are
 * exclusively a 2026-07-28 wire feature), and reused by the MCP Tasks extension work for the same reason:
 * a per-request `_meta` envelope claim (client capabilities/extensions) is likewise a 2026-07-28-only
 * concept with no `InMemoryTransport` equivalent.
 */
export async function connectModern(
  buildServer: () => McpServer,
  clientName: string,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const handler = createMcpHandler(buildServer);
  const client = new Client({ name: clientName, version: "0.0.1" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://in-process.kohaku-test.invalid/mcp"), {
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

/**
 * Sends one raw JSON-RPC request straight to a `createMcpHandler`-built endpoint over the in-process `fetch`
 * bridge, bypassing `@modelcontextprotocol/client`'s `Client` entirely, and returns the parsed JSON-RPC
 * response body.
 *
 * Needed (rather than `connectModern` + `Client.callTool`) for two reasons the MCP Tasks extension work ran
 * into:
 *  1. A modern (2026-07-28) request MUST carry its own per-request `_meta` envelope claim (`protocolVersion`
 *     + `clientCapabilities`, SEP's REQUIRED_ENVELOPE_KEYS) — `Client`'s own request-building machinery
 *     populates this from the client's own fixed, connection-time capabilities, with no per-call override
 *     surface for `clientCapabilities.extensions`. Building the request by hand is the only way to declare
 *     the Tasks extension (`io.modelcontextprotocol/tasks`) on ONE SPECIFIC call without declaring it on
 *     every call this client makes.
 *  2. `@modelcontextprotocol/client`'s own result decoder rejects any `resultType` other than `"complete"`/
 *     `"input_required"` with `SdkErrorCode.UnsupportedResultType` (verified empirically) — since this
 *     extension's `CreateTaskResult` carries `resultType: "task"`, `Client.callTool()` would throw
 *     client-side before ever handing back a parsed result. The raw JSON-RPC response bypasses that decoder
 *     entirely, which is also a faithful stand-in for how a real Tasks-aware client (which this SDK version
 *     does not ship) would actually need to read the wire.
 *
 * `createMcpHandler`'s SEP-2243 pre-dispatch validation additionally requires the `Mcp-Method` (and, for
 * `tools/call`, `Mcp-Name`) headers to agree with the JSON-RPC body — this helper fills them in from `body`.
 */
export async function sendRawModern(
  buildServer: () => McpServer,
  body: { jsonrpc: "2.0"; id: number | string; method: string; params?: Record<string, unknown> },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const handler = createMcpHandler(buildServer);
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-method": body.method,
      "mcp-protocol-version": "2026-07-28",
    };
    const toolName = (body.params as { name?: unknown } | undefined)?.name;
    if (typeof toolName === "string") headers["mcp-name"] = toolName;
    const res = await handler.fetch(
      new Request("http://in-process.kohaku-test.invalid/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
    const text = await res.text();
    // A modern-era success response streams back as one SSE "message" event rather than a bare JSON body
    // (see http.smoke.test.ts's SSE parsing for the production-path equivalent) — accept either framing.
    const jsonText = text.startsWith("event:") ? (text.match(/^data: (.+)$/m)?.[1] ?? text) : text;
    return { status: res.status, json: JSON.parse(jsonText) as Record<string, unknown> };
  } finally {
    await handler.close();
  }
}

/**
 * The 2026-07-28 per-request `_meta` envelope claim declaring the MCP Tasks extension
 * (`io.modelcontextprotocol/tasks`) on one specific request, for use as `params._meta` with `sendRawModern`.
 * Mirrors `../src/tasks.ts`'s `TASKS_EXTENSION_ID` and the SDK's own
 * `io.modelcontextprotocol/protocolVersion` / `io.modelcontextprotocol/clientCapabilities` meta keys
 * (`PROTOCOL_VERSION_META_KEY` / `CLIENT_CAPABILITIES_META_KEY`, re-spelled here as literals rather than
 * imported so this helper does not need a `@modelcontextprotocol/server` import of its own beyond `McpServer`
 * — the literal values are pinned by `mcp.test.ts`'s existing `TRACEPARENT_META_KEY`-style usage elsewhere).
 */
export function taskExtensionEnvelope(): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {
      extensions: { "io.modelcontextprotocol/tasks": {} },
    },
  };
}

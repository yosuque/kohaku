import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KOHAKU_MCP_LIST_CACHE_HINT, RENDERER_RESOURCE_CACHE_HINT } from "@kohaku-ui/host-mcp-apps";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpHttpServer } from "../src/http.js";
import { createKohakuMcpSetup } from "../src/setup.js";

/**
 * End-to-end check of setup.ts's `cacheHints: defaultMcpListCacheHints()` wiring (MCP 2026-07-28 /
 * SEP-2549), over the actual production entry point (src/http.ts's Streamable HTTP server, same as
 * http.smoke.test.ts) rather than an in-process shortcut — this is the one test in the repo that
 * exercises the real `new McpServer(...)` construction in setup.ts, so a regression there (e.g. the
 * `cacheHints` option silently dropped in a future refactor) is caught here even though
 * packages/host-mcp-apps/test/mcp.test.ts already covers the underlying cache-hint plumbing in
 * isolation.
 *
 * `versionNegotiation: { mode: "auto" }` is required to see these fields at all: SEP-2549's
 * `ttlMs`/`cacheScope` are exclusively a 2026-07-28 ("modern era") wire feature, and a plain
 * `new Client(...)` (the default, as http.smoke.test.ts uses) negotiates only the legacy 2025-11-25
 * handshake. The Streamable HTTP entry (`createMcpHttpServer`, built on `createMcpHandler`) already
 * classifies and serves modern-era exchanges per request regardless of this option — this option only
 * controls whether the CLIENT probes for and adopts that era.
 *
 * stdio (src/index.ts) is not covered here: it connects a hand-constructed `McpServer` directly to a
 * transport, bypassing `createMcpHandler`'s per-request era classification entirely, so it never
 * negotiates past the legacy era regardless of the `cacheHints` passed to the constructor — the
 * `ttlMs`/`cacheScope` fields configured in setup.ts simply never appear on that transport's wire. This
 * is not a regression introduced by this feature (this repo's stdio entry never spoke the modern era
 * before this change either) and is unrelated to whether the hints are wired correctly.
 */
describe("sample-mcp: response caching (MCP 2026-07-28 / SEP-2549)", () => {
  let httpServer: Server;
  let client: Client;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "kohaku-mcp-cache-hints-"));
    const setup = await createKohakuMcpSetup({ llm: new FakeLlm({ objects: [] }), dataDir });
    httpServer = createMcpHttpServer({ createServer: setup.createServer, snapshotDir: setup.snapshotDir });

    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    const address = httpServer.address() as AddressInfo;
    const url = new URL(`http://127.0.0.1:${address.port}/mcp`);

    client = new Client(
      { name: "cache-hints-client", version: "0.0.1" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(new StreamableHTTPClientTransport(url));
  });

  afterAll(async () => {
    await client?.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
      httpServer.closeAllConnections?.();
    });
    await rm(dataDir, { recursive: true, force: true });
  });

  it("tools/list and resources/list carry KOHAKU_MCP_LIST_CACHE_HINT", async () => {
    const tools = await client.listTools();
    expect((tools as unknown as { ttlMs?: number }).ttlMs).toBe(KOHAKU_MCP_LIST_CACHE_HINT.ttlMs);
    expect((tools as unknown as { cacheScope?: string }).cacheScope).toBe(
      KOHAKU_MCP_LIST_CACHE_HINT.cacheScope,
    );

    const resources = await client.listResources();
    expect((resources as unknown as { ttlMs?: number }).ttlMs).toBe(KOHAKU_MCP_LIST_CACHE_HINT.ttlMs);
    expect((resources as unknown as { cacheScope?: string }).cacheScope).toBe(
      KOHAKU_MCP_LIST_CACHE_HINT.cacheScope,
    );
  });

  it("resources/read on the renderer resource carries RENDERER_RESOURCE_CACHE_HINT (this profile's per-resource default; unaffected by the list hint above)", async () => {
    const read = await client.readResource({ uri: "ui://kohaku/renderer.html" });
    expect((read as unknown as { ttlMs?: number }).ttlMs).toBe(RENDERER_RESOURCE_CACHE_HINT.ttlMs);
    expect((read as unknown as { cacheScope?: string }).cacheScope).toBe(
      RENDERER_RESOURCE_CACHE_HINT.cacheScope,
    );
  });
});

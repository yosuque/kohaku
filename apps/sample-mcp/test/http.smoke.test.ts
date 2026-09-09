import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpHttpServer } from "../src/http.js";
import { createKohakuMcpSetup } from "../src/setup.js";

/**
 * Smoke test of the Streamable HTTP entry (src/http.ts).
 * Starts the HTTP server on an ephemeral port and runs initialize → tools/list → resources/read
 * via the SDK's StreamableHTTPClientTransport.
 * The common setup (createKohakuMcpSetup) is assembled with a FakeLlm + an mkdtemp temp .data, and
 * completes without the LLM (the L0 path), same as lineage-wiring.test.ts.
 */
describe("sample-mcp: Streamable HTTP entry smoke", () => {
  let httpServer: Server;
  let client: Client;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "kohaku-mcp-http-"));
    // Set up with a FakeLlm (empty script), touching neither env nor a real LLM.
    const setup = await createKohakuMcpSetup({ llm: new FakeLlm({ objects: [] }), dataDir });
    httpServer = createMcpHttpServer({ createServer: setup.createServer, snapshotDir: setup.snapshotDir });

    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    const address = httpServer.address() as AddressInfo;
    const url = new URL(`http://127.0.0.1:${address.port}/mcp`);

    client = new Client({ name: "http-smoke-client", version: "0.0.1" });
    // connect performs the initialize handshake and establishes the mcp-session-id.
    await client.connect(new StreamableHTTPClientTransport(url));
  });

  afterAll(async () => {
    // Close the client, then reliably close the HTTP server (prevents SSE streams from lingering).
    await client?.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
      // Force-close remaining sockets (GET SSE, etc.) to reliably fire the close callback.
      httpServer.closeAllConnections?.();
    });
    await rm(dataDir, { recursive: true, force: true });
  });

  it("tools/list lists core tools and intent tools", async () => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    // Both the generic tools (host-mcp-apps) and the intent tools (from the catalog) are exposed.
    expect(names.has("kohaku_compose"), "kohaku_compose").toBe(true);
    expect(names.has("kohaku_render_snapshot"), "kohaku_render_snapshot").toBe(true);
    expect(names.has("sales_quarterly_summary"), "sales_quarterly_summary").toBe(true);
  });

  it("resources/read returns the shared renderer HTML", async () => {
    const result = await client.readResource({ uri: "ui://kohaku/renderer.html" });
    expect(result.contents.length).toBeGreaterThan(0);
    const first = result.contents[0]!;
    expect(first.uri).toBe("ui://kohaku/renderer.html");
    // Even if the renderer is not built, FALLBACK_HTML is returned, so it must be non-empty HTML (text kind).
    expect("text" in first).toBe(true);
    const text = "text" in first ? String(first.text) : "";
    expect(text.length).toBeGreaterThan(0);
  });
});

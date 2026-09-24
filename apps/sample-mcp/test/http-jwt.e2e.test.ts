import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpHttpServer } from "../src/http.js";
import { createKohakuMcpSetup } from "../src/setup.js";

/**
 * End-to-end proof (real Streamable HTTP, not a mock) that under KOHAKU_AUTHZ=jwt, http.ts no longer
 * resolves authz on its own (removed) and instead relies entirely on createKohakuMcpSetup's own default
 * resolvePrincipal (setup.ts): a tool call with no bearer token is a structured tool error, and one with a
 * valid HS256 (32+ byte secret) token succeeds.
 */
const SECRET = "test-secret-at-least-32-bytes-long-000";

async function jwt(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(SECRET));
}

describe("sample-mcp Streamable HTTP under KOHAKU_AUTHZ=jwt", () => {
  let httpServer: Server | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    delete process.env["KOHAKU_AUTHZ"];
    delete process.env["KOHAKU_JWT_SECRET"];
    delete process.env["KOHAKU_STORAGE"];
    if (httpServer != null) {
      await new Promise<void>((resolve) => {
        httpServer!.close(() => resolve());
        httpServer!.closeAllConnections?.();
      });
      httpServer = undefined;
    }
    if (dataDir != null) {
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
      dataDir = undefined;
    }
  });

  async function startJwtServer(): Promise<URL> {
    process.env["KOHAKU_AUTHZ"] = "jwt";
    process.env["KOHAKU_JWT_SECRET"] = SECRET;
    process.env["KOHAKU_STORAGE"] = "memory";
    dataDir = mkdtempSync(join(tmpdir(), "kohaku-mcp-http-jwt-"));
    const setup = await createKohakuMcpSetup({ llm: new FakeLlm({ objects: [] }), dataDir });
    httpServer = createMcpHttpServer({ createServer: setup.createServer, snapshotDir: setup.snapshotDir });
    await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", () => resolve()));
    const address = httpServer.address() as AddressInfo;
    return new URL(`http://127.0.0.1:${address.port}/mcp`);
  }

  it("without a bearer token, calling an intent tool fails closed (isError)", async () => {
    const url = await startJwtServer();
    const client = new Client({ name: "jwt-e2e-no-token", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(url));
    const result = await client.callTool({ name: "sales_quarterly_summary", arguments: {} });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("with a valid bearer token, the tool call reaches the principal and succeeds", async () => {
    const url = await startJwtServer();
    const token = await jwt({ sub: "u1", roles: ["admin"], tenant: "acme" });
    const client = new Client({ name: "jwt-e2e-with-token", version: "0.0.1" });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const result = await client.callTool({ name: "sales_quarterly_summary", arguments: {} });
    expect(result.isError).not.toBe(true);
    await client.close();
  });
});

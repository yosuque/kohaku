import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpHttpServer, type McpHttpServerOptions } from "../src/mcp-http.js";

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const servers: Server[] = [];

/** Start the helper on an ephemeral port with a trivial McpServer; every server is closed after each test. */
async function start(overrides: Partial<McpHttpServerOptions> = {}): Promise<number> {
  const httpServer = createMcpHttpServer({
    createServer: () => new McpServer({ name: "mcp-http-test", version: "0.0.1" }),
    allowedHosts: [],
    allowedOrigins: [],
    ...overrides,
  });
  servers.push(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  return (httpServer.address() as AddressInfo).port;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (httpServer) =>
        new Promise<void>((resolve, reject) => {
          httpServer.close((err) => (err ? reject(err) : resolve()));
          httpServer.closeAllConnections?.();
        }),
    ),
  );
});

describe("createMcpHttpServer (defaults follow the kohaku init --mcp server)", () => {
  it("answers an OPTIONS preflight with 204 and the four default CORS headers only", async () => {
    const port = await start();
    const res = await send(port, "OPTIONS", "/mcp", { Origin: "http://localhost:5173" });
    expect(res.status).toBe(204);
    expect(res.body).toBe("");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res.headers["vary"]).toBe("Origin");
    expect(res.headers["access-control-allow-methods"]).toBe("GET, POST, DELETE, OPTIONS");
    expect(res.headers["access-control-allow-headers"]).toBe(
      "Content-Type, Accept, Authorization, mcp-protocol-version",
    );
    expect(res.headers["access-control-max-age"]).toBeUndefined();
  });

  it("emits no CORS headers without an Origin, and rejects a disallowed Origin with 403", async () => {
    const port = await start();
    const bare = await send(port, "OPTIONS", "/mcp");
    expect(bare.status).toBe(204);
    expect(Object.keys(bare.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
    const evil = await send(port, "OPTIONS", "/mcp", { Origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects a Host that is neither local nor listed with 403, and accepts a listed one", async () => {
    const port = await start({ allowedHosts: ["tunnel.example"] });
    expect((await send(port, "POST", "/mcp", { Host: "evil.example" }, "{}")).status).toBe(403);
    expect((await send(port, "OPTIONS", "/mcp", { Host: "evil.example" })).status).toBe(403);
    expect((await send(port, "OPTIONS", "/mcp", { Host: "tunnel.example" })).status).toBe(204);
  });

  it("answers a malformed-JSON POST with 400 / -32700 Parse error", async () => {
    const port = await start();
    const res = await send(port, "POST", "/mcp", { "Content-Type": "application/json" }, "{not json");
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error" },
      id: null,
    });
  });

  it("caps the POST body: 413 / -32000 with the default message, and Connection: close", async () => {
    const port = await start({ maxBodyBytes: 64 });
    const res = await send(port, "POST", "/mcp", { "Content-Type": "application/json" }, "x".repeat(200));
    expect(res.status).toBe(413);
    expect(res.headers["connection"]).toBe("close");
    expect(JSON.parse(res.body)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Request body too large" },
      id: null,
    });
  });

  it("serves every path through the MCP handler when no path is set", async () => {
    const port = await start();
    // The handler answers GET with 405 (stateless serving has no standalone stream); a 404 would mean the helper routed it.
    expect((await send(port, "GET", "/anything")).status).toBe(405);
  });
});

describe("createMcpHttpServer options", () => {
  it("runs routes before the MCP path, and falls through to the MCP handler when a route returns false", async () => {
    const seen: string[] = [];
    const port = await start({
      path: "/mcp",
      routes: (req, res, url) => {
        seen.push(`${req.method} ${url.pathname}`);
        if (url.pathname === "/static") {
          res.writeHead(200, { "Content-Type": "text/plain" }).end("from route");
          return true;
        }
        return false;
      },
    });
    const claimed = await send(port, "GET", "/static");
    expect(claimed.status).toBe(200);
    expect(claimed.body).toBe("from route");
    // Not claimed: the MCP path is reached (a malformed body is answered by the MCP leg, not by a 404).
    const fell = await send(port, "POST", "/mcp", {}, "{not json");
    expect(fell.status).toBe(400);
    expect(seen).toEqual(["GET /static", "POST /mcp"]);
  });

  it("answers a path other than `path` with a 404 -32601 unless a route claimed it", async () => {
    const port = await start({ path: "/mcp" });
    const res = await send(port, "GET", "/nope?x=1");
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32601, message: "Not found: /nope" },
      id: null,
    });
  });

  it("applies the CORS additions, the invalidJson / bodyTooLargeMessage overrides and reports through onError", async () => {
    const errors: string[] = [];
    const port = await start({
      maxBodyBytes: 64,
      bodyTooLargeMessage: "too big",
      corsAllowHeaders: ["Last-Event-ID"],
      corsMaxAgeSeconds: 600,
      invalidJson: { status: 500, code: -32603, message: "Internal error" },
      onError: (stage) => errors.push(stage),
    });
    const preflight = await send(port, "OPTIONS", "/mcp", { Origin: "http://localhost:5173" });
    expect(preflight.headers["access-control-allow-headers"]).toBe(
      "Content-Type, Accept, Authorization, mcp-protocol-version, Last-Event-ID",
    );
    expect(preflight.headers["access-control-max-age"]).toBe("600");

    const malformed = await send(port, "POST", "/mcp", {}, "{not json");
    expect(malformed.status).toBe(500);
    expect(JSON.parse(malformed.body).error).toEqual({ code: -32603, message: "Internal error" });
    expect(errors).toEqual(["request"]);

    const huge = await send(port, "POST", "/mcp", {}, "x".repeat(200));
    expect(huge.status).toBe(413);
    expect(JSON.parse(huge.body).error).toEqual({ code: -32000, message: "too big" });
  });
});

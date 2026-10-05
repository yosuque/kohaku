import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { request, type Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpHttpServer } from "../src/http.js";

/**
 * Characterization of src/http.ts's HTTP scaffold (CORS preflight, error bodies, routing order). It pins what the
 * server answers today, so the scaffold can be extracted into a shared helper without changing a byte on the wire.
 */

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** Send a request head that declares a body larger than the limit, then read whatever the server answers. */
function overLimitDeclared(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (c) => (raw += c));
    socket.on("end", () => resolve(raw));
    socket.on("error", reject);
    socket.write(
      [
        "POST /mcp HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Content-Type: application/json",
        `Content-Length: ${10 * 1024 * 1024}`,
        "",
        "",
      ].join("\r\n"),
    );
  });
}

describe("createMcpHttpServer: wire-level characterization", () => {
  let httpServer: Server;
  let port: number;
  let baseDir: string;
  let hostHeader: string;

  beforeAll(async () => {
    baseDir = mkdtempSync(join(tmpdir(), "kohaku-mcp-char-"));
    httpServer = createMcpHttpServer({
      createServer: () => new McpServer({ name: "char-test", version: "0.0.1" }),
      snapshotDir: join(baseDir, "snapshots"),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    port = (httpServer.address() as AddressInfo).port;
    hostHeader = `127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
      httpServer.closeAllConnections?.();
    });
    await rm(baseDir, { recursive: true, force: true });
  });

  it("an OPTIONS preflight answers 204 with exactly the CORS headers, including Last-Event-ID and Max-Age", async () => {
    const res = await send(port, "OPTIONS", "/mcp", { Host: hostHeader, Origin: "http://localhost:5173" });
    expect(res.status).toBe(204);
    expect(res.body).toBe("");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res.headers["vary"]).toBe("Origin");
    expect(res.headers["access-control-allow-methods"]).toBe("GET, POST, DELETE, OPTIONS");
    expect(res.headers["access-control-allow-headers"]).toBe(
      "Content-Type, Accept, Authorization, mcp-protocol-version, Last-Event-ID",
    );
    expect(res.headers["access-control-max-age"]).toBe("86400");
    expect(res.headers["content-type"]).toBeUndefined();
    expect(res.headers["content-length"]).toBeUndefined();
  });

  it("an OPTIONS preflight without an Origin carries no CORS headers", async () => {
    const res = await send(port, "OPTIONS", "/mcp", { Host: hostHeader });
    expect(res.status).toBe(204);
    expect(Object.keys(res.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
    expect(res.headers["vary"]).toBeUndefined();
  });

  it("a malformed-JSON POST answers 500 with a JSON-RPC -32603 Internal error body", async () => {
    const res = await send(
      port,
      "POST",
      "/mcp",
      { Host: hostHeader, "Content-Type": "application/json" },
      "{not json",
    );
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error" },
      id: null,
    });
  });

  it("a POST whose declared Content-Length is over the limit answers 413 / -32000 and closes the connection", async () => {
    const raw = await overLimitDeclared(port);
    const [head, body = ""] = raw.split("\r\n\r\n");
    expect(head).toMatch(/^HTTP\/1\.1 413 /);
    expect(head?.toLowerCase()).toContain("connection: close");
    expect(head?.toLowerCase()).toContain("content-type: application/json");
    // The body may arrive chunk-framed on the raw socket, so take the JSON object out of it.
    const json = body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1);
    expect(JSON.parse(json)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Request body exceeds the limit (4194304 bytes)" },
      id: null,
    });
  });

  it("an unknown path answers 404 / -32601 with the path in the message", async () => {
    const res = await send(port, "GET", "/nope?x=1", { Host: hostHeader });
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32601, message: "Not found: /nope" },
      id: null,
    });
  });

  it("the Host check runs before routing: a bad Host is 403 on an unknown path, the MCP path and the snapshot path", async () => {
    const evil = { Host: "evil.example" };
    expect((await send(port, "GET", "/nope", evil)).status).toBe(403);
    expect(
      (await send(port, "POST", "/mcp", { ...evil, "Content-Type": "application/json" }, "{not json")).status,
    ).toBe(403);
    expect((await send(port, "GET", "/snapshots/x.html", evil)).status).toBe(403);
    expect((await send(port, "OPTIONS", "/nope", evil)).status).toBe(403);
  });

  it("the Origin check also runs before routing: a bad Origin is 403 on an unknown path", async () => {
    const res = await send(port, "GET", "/nope", { Host: hostHeader, Origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });
});

import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowedHostnameOf, createMcpHttpServer } from "../src/http.js";

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
}

function send(port: number, method: string, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/nope", method, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("allowedHostnameOf", () => {
  it.each([
    ["localhost", "localhost"],
    ["allowed.example:9999", "allowed.example"],
    ["https://x.trycloudflare.com", "x.trycloudflare.com"],
    ["https://x.example:8443/path", "x.example"],
    ["[::1]:8788", "[::1]"],
    ["[::1]", "[::1]"],
    ["  spaced.example  ", "spaced.example"],
  ])("%s -> %s", (entry, hostname) => {
    expect(allowedHostnameOf(entry)).toBe(hostname);
  });
});

/**
 * DNS rebinding / CSRF protection is on by default (no options at all), matching `kohaku init --mcp`'s
 * generated server: Host and Origin must be a localhost name (or listed), and CORS echoes only a validated Origin.
 */
describe("createMcpHttpServer: Host / Origin validation and CORS", () => {
  let httpServer: Server;
  let port: number;
  let baseDir: string;

  beforeAll(async () => {
    baseDir = mkdtempSync(join(tmpdir(), "kohaku-mcp-dns-"));
    httpServer = createMcpHttpServer({
      createServer: () => new McpServer({ name: "dns-test", version: "0.0.1" }),
      snapshotDir: join(baseDir, "snapshots"),
      allowedHosts: ["tunnel.example"],
      allowedOrigins: ["app.example"],
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
      httpServer.closeAllConnections?.();
    });
    await rm(baseDir, { recursive: true, force: true });
  });

  it("allows the localhost names and a listed host, rejects any other Host with 403", async () => {
    expect((await send(port, "GET", { Host: `127.0.0.1:${port}` })).status).toBe(404);
    expect((await send(port, "GET", { Host: `localhost:${port}` })).status).toBe(404);
    expect((await send(port, "GET", { Host: "tunnel.example" })).status).toBe(404);
    expect((await send(port, "GET", { Host: "evil.example" })).status).toBe(403);
  });

  it("rejects an Origin that is not allowed with 403, and never answers with Access-Control-Allow-Origin: *", async () => {
    const evil = await send(port, "POST", { Host: `127.0.0.1:${port}`, Origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("echoes a validated Origin (with Vary: Origin) on the preflight and on a normal response", async () => {
    const preflight = await send(port, "OPTIONS", {
      Host: `127.0.0.1:${port}`,
      Origin: "https://app.example",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("https://app.example");
    expect(preflight.headers["vary"]).toBe("Origin");

    const local = await send(port, "GET", { Host: `127.0.0.1:${port}`, Origin: "http://localhost:5173" });
    expect(local.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("a request with no Origin (a non-browser client) passes and gets no CORS headers", async () => {
    const res = await send(port, "GET", { Host: `127.0.0.1:${port}` });
    expect(res.status).toBe(404);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects a preflight from a disallowed Host before answering it", async () => {
    const res = await send(port, "OPTIONS", { Host: "evil.example", Origin: "https://app.example" });
    expect(res.status).toBe(403);
  });
});

import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { type IncomingMessage, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpHttpServer, parseAllowedHosts, readJsonBody } from "../src/http.js";

/**
 * Regression guard for src/http.ts hardening (body size limit / parseAllowedHosts). None depend on
 * the LLM. Pure functions are verified deterministically; the HTTP paths use the
 * ephemeral-port-start + reliable-close style.
 *
 * The session-limit / idle-TTL regression tests this file used to carry (`findExpiredSessions`, the
 * "session cap (HTTP path)" describe block below) are gone along with the session registry itself
 * (see src/http.ts's top doc comment) — protocol version 2026-07-28 removed protocol-level sessions,
 * and `createMcpHandler` serves every request statelessly, so there is no longer a session count or
 * an idle session to bound.
 */

/** Create a Readable equivalent to IncomingMessage (for deterministic verification of readJsonBody). Only the minimal headers are attached. */
function fakeReq(chunks: Buffer[], headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from(chunks) as unknown as IncomingMessage;
  (stream as unknown as { headers: Record<string, string> }).headers = headers;
  return stream;
}

/** POST via node:http and resolve on whichever comes first, the response or a connection error (to also allow a reset on cutoff). */
function postRaw(
  port: number,
  path: string,
  body: Buffer | string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status?: number; body?: string; error?: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: { status?: number; body?: string; error?: string }): void => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { "content-type": "application/json", ...extraHeaders },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => finish({ status: res.statusCode ?? 0, body: data }));
        res.on("error", () => finish({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", (e) => finish({ error: e.message }));
    req.end(body);
  });
}

describe("parseAllowedHosts", () => {
  it("empty / undefined / all-empty after trim yields undefined (protection off)", () => {
    expect(parseAllowedHosts(undefined)).toBeUndefined();
    expect(parseAllowedHosts("")).toBeUndefined();
    expect(parseAllowedHosts("   ")).toBeUndefined();
    expect(parseAllowedHosts(" , , ")).toBeUndefined();
  });

  it("comma split + trim + empty element removal", () => {
    expect(parseAllowedHosts("localhost:8788,127.0.0.1:8788")).toEqual(["localhost:8788", "127.0.0.1:8788"]);
    expect(parseAllowedHosts("  a , b ,")).toEqual(["a", "b"]);
    expect(parseAllowedHosts("only")).toEqual(["only"]);
  });
});

describe("readJsonBody (body size limit)", () => {
  it("parses and returns JSON within the limit", async () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");
    await expect(readJsonBody(fakeReq([body]))).resolves.toEqual({ hello: "world" });
  });

  it("an empty body yields undefined", async () => {
    await expect(readJsonBody(fakeReq([]))).resolves.toBeUndefined();
  });

  it("aborts before receiving when Content-Length exceeds the limit", async () => {
    // Declare 10 MiB (exceeds the 4 MiB limit). Even with small actual data, the pre-check rejects it.
    const req = fakeReq([Buffer.from("x")], { "content-length": String(10 * 1024 * 1024) });
    await expect(readJsonBody(req)).rejects.toThrow(/Request body exceeds the limit/);
  });

  it("aborts mid-receive when the cumulative size exceeds the limit", async () => {
    // Without Content-Length (chunked-equivalent), stream a total of 5 MiB (> 4 MiB limit).
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    await expect(readJsonBody(fakeReq([chunk, chunk, chunk, chunk, chunk]))).rejects.toThrow(
      /Request body exceeds the limit/,
    );
  });
});

describe("POST body size limit (HTTP path)", () => {
  let httpServer: Server;
  let port: number;
  let snapshotDir: string;

  beforeAll(async () => {
    // The body-size check is before reaching the transport, so a minimal McpServer is enough (no session establishment needed).
    snapshotDir = mkdtempSync(join(tmpdir(), "kohaku-mcp-s1-"));
    httpServer = createMcpHttpServer({
      createServer: () => new McpServer({ name: "s1-test", version: "0.0.1" }),
      snapshotDir,
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
      httpServer.closeAllConnections?.();
    });
    await rm(snapshotDir, { recursive: true, force: true });
  });

  it("an over-limit POST body is rejected and the server keeps running", async () => {
    const huge = Buffer.alloc(5 * 1024 * 1024, 0x61); // 5 MiB > 4 MiB limit
    const result = await postRaw(port, "/mcp", huge);
    // Either 413 (explicit error) or a connection reset (early close from the cutoff) = it was rejected.
    expect(result.status === 413 || result.error != null).toBe(true);
    // Confirm the server has not crashed (it responds to a subsequent request on another connection).
    const alive = await fetch(`http://127.0.0.1:${port}/snapshots/does-not-exist.html`);
    expect(alive.status).toBe(404);
  });

  it("a within-limit POST body is processed normally (the size check does not false-positive)", async () => {
    // A bare tools/list with no prior initialize and no Accept header reaches the SDK's own HTTP
    // routing (a 406 content-negotiation rejection, not our body-size guard) — this pins that the
    // size check passed cleanly and control reached createMcpHandler's real request handling, the
    // same thing the pre-migration "a non-initialize with no established session is 400" assertion
    // pinned against the old stateful session registry (removed; see src/http.ts's top doc comment).
    const small = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const result = await postRaw(port, "/mcp", small);
    expect(result.status).toBe(406);
    expect(result.body).not.toContain("exceeds the limit");
  });
});

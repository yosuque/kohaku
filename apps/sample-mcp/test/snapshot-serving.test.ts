import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpHttpServer } from "../src/http.js";
import { makeRendererHtmlLoader, makeSnapshotLocator } from "../src/setup.js";

/**
 * GET with an arbitrary Host header (for verifying the DNS rebinding protection).
 * Since fetch (undici) cannot override Host as a forbidden header, use node:http to set Host explicitly.
 * The TCP destination (127.0.0.1:port) and the Host header value are independent, so any Host can be sent even on an ephemeral port.
 */
function getWithHost(
  port: number,
  path: string,
  hostHeader: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { Host: hostHeader } },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Regression guard for snapshot serving toward remote MCP (Streamable HTTP).
 * - makeSnapshotLocator (pure function): branching on the presence of a base URL and the encode round-trip.
 * - createMcpHttpServer's GET /snapshots/<file> static serving (200 / text/html / body match, 404, traversal rejection).
 * None depend on the LLM. HTTP uses the ephemeral-port-start + reliable-close style, same as http.smoke.test.ts.
 */
describe("makeSnapshotLocator (pure function for locator decision)", () => {
  it("returns a public URL when snapshotBaseUrl is set, otherwise a local path", () => {
    expect(
      makeSnapshotLocator({
        snapshotBaseUrl: "https://xxx.trycloudflare.com",
        snapshotDir: "/data/snapshots",
        fileName: "snapshot-abc.html",
      }),
    ).toBe("https://xxx.trycloudflare.com/snapshots/snapshot-abc.html");

    expect(makeSnapshotLocator({ snapshotDir: "/data/snapshots", fileName: "snapshot-abc.html" })).toBe(
      join("/data/snapshots", "snapshot-abc.html"),
    );
  });

  it("URL encoding uses encodeURIComponent and round-trips via the server-side decodeURIComponent", () => {
    const url = makeSnapshotLocator({
      snapshotBaseUrl: "https://x.example",
      snapshotDir: "/d",
      fileName: "a:b.html",
    });
    expect(url).toBe("https://x.example/snapshots/a%3Ab.html");
    // The serving side (http.ts serveSnapshot) decodeURIComponent's the last segment to restore it.
    expect(decodeURIComponent("a%3Ab.html")).toBe("a:b.html");
  });
});

describe("makeRendererHtmlLoader (memoize only successful renderer HTML loads)", () => {
  it("a successful load reads once and returns the cache thereafter", () => {
    let reads = 0;
    const load = makeRendererHtmlLoader({
      exists: () => true,
      read: () => {
        reads++;
        return "<html>renderer</html>";
      },
      fallback: "<html>fallback</html>",
    });
    expect(load()).toBe("<html>renderer</html>");
    expect(load()).toBe("<html>renderer</html>");
    expect(reads).toBe(1); // even called twice, read happens once
  });

  it("returns fallback and does not cache when the file is absent (picks it up once built later)", () => {
    let exists = false;
    let reads = 0;
    const load = makeRendererHtmlLoader({
      exists: () => exists,
      read: () => {
        reads++;
        return "<html>renderer</html>";
      },
      fallback: "<html>fallback</html>",
    });
    expect(load()).toBe("<html>fallback</html>"); // absent → fallback (not cached)
    expect(reads).toBe(0);
    exists = true; // built later
    expect(load()).toBe("<html>renderer</html>"); // picked up on the next call
    expect(load()).toBe("<html>renderer</html>");
    expect(reads).toBe(1); // memoized only from the successful read onward
  });
});

describe("GET /snapshots/<file> static serving", () => {
  const KNOWN_HTML = "<!DOCTYPE html><html><body>known snapshot</body></html>";
  const SECRET = "TOP-SECRET-DO-NOT-LEAK";
  let httpServer: Server;
  let baseUrl: string;
  let baseDir: string;

  beforeAll(async () => {
    // Place a known HTML in base/snapshots and a secret file directly under base (one level up) to attempt traversal.
    baseDir = mkdtempSync(join(tmpdir(), "kohaku-snap-serve-"));
    const snapshotDir = join(baseDir, "snapshots");
    mkdirSync(snapshotDir);
    writeFileSync(join(snapshotDir, "snapshot-known.html"), KNOWN_HTML, "utf8");
    writeFileSync(join(baseDir, "secret.txt"), SECRET, "utf8");

    // createServer is not called for /snapshots serving (only on POST initialize). A minimal McpServer is enough.
    httpServer = createMcpHttpServer({
      createServer: () => new McpServer({ name: "snap-serve-test", version: "0.0.1" }),
      snapshotDir,
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    const address = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
      httpServer.closeAllConnections?.();
    });
    await rm(baseDir, { recursive: true, force: true });
  });

  it("an existing snapshot returns 200 / text/html / matching body", async () => {
    const res = await fetch(`${baseUrl}/snapshots/snapshot-known.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe(KNOWN_HTML);
  });

  it("a non-existent file returns 404", async () => {
    const res = await fetch(`${baseUrl}/snapshots/does-not-exist.html`);
    expect(res.status).toBe(404);
  });

  it("encoded traversal (..%2fsecret.txt) is rejected with 4xx and does not return secret content", async () => {
    const res = await fetch(`${baseUrl}/snapshots/..%2fsecret.txt`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("multi-level traversal (..%2f..%2fsetup.ts) is also rejected with 4xx", async () => {
    const res = await fetch(`${baseUrl}/snapshots/..%2f..%2fsetup.ts`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await res.text()).not.toContain("createKohakuMcpSetup");
  });

  // Cases that individually hit the reject branch for backslash / NUL (not containing `..`).
  it("a lone backslash (%5C without ..) is rejected with 400", async () => {
    // %5C is not normalized to `/` by the URL parser, so it is caught by the basename validation for the decoded `\`.
    const res = await fetch(`${baseUrl}/snapshots/foo%5Cbar.html`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid file name");
  });

  it("a path with NUL (%00) is rejected with 400", async () => {
    const res = await fetch(`${baseUrl}/snapshots/foo%00.html`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid file name");
  });
});

describe("Host validation when allowedHosts is set (the snapshot path is also protected before routing)", () => {
  const KNOWN_HTML = "<!DOCTYPE html><html><body>guarded snapshot</body></html>";
  // To avoid depending on the ephemeral port, use a fixed allowed Host independent of the TCP destination.
  const ALLOWED_HOST = "allowed.example:9999";
  let httpServer: Server;
  let port: number;
  let baseDir: string;

  beforeAll(async () => {
    baseDir = mkdtempSync(join(tmpdir(), "kohaku-snap-host-"));
    const snapshotDir = join(baseDir, "snapshots");
    mkdirSync(snapshotDir);
    writeFileSync(join(snapshotDir, "snapshot-known.html"), KNOWN_HTML, "utf8");
    httpServer = createMcpHttpServer({
      createServer: () => new McpServer({ name: "snap-host-test", version: "0.0.1" }),
      snapshotDir,
      allowedHosts: [ALLOWED_HOST],
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

  it("serves the snapshot with 200 for an allowed Host", async () => {
    const res = await getWithHost(port, "/snapshots/snapshot-known.html", ALLOWED_HOST);
    expect(res.status).toBe(200);
    expect(res.body).toBe(KNOWN_HTML);
  });

  it("an invalid Host returns 403 even on the snapshot path (rejected before routing, no content returned)", async () => {
    const res = await getWithHost(port, "/snapshots/snapshot-known.html", "evil.example");
    expect(res.status).toBe(403);
    expect(res.body).not.toContain("guarded snapshot");
  });
});

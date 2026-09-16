/**
 * MCP server for external chat clients (Streamable HTTP).
 *
 * claude.ai / ChatGPT can only connect through remote MCP connectors (Streamable HTTP),
 * so in addition to stdio (src/index.ts) this HTTP entry point is provided. The common setup
 * (Ports, .data, catalog) is shared with src/setup.ts.
 *
 * ⚠️ No authentication (demo). This HTTP entry has no authentication whatsoever. It assumes
 *    local use (localhost:8788); when connecting claude.ai / ChatGPT through a public tunnel
 *    (ngrok / cloudflared, etc.), anyone who knows the URL can view and operate the sales data.
 *    Share only with trusted parties and do not put sensitive data on it.
 *
 * Usage:
 *   pnpm --filter @kohaku-ui-sample/mcp start:http           # listen on :8788 (/mcp)
 *   KOHAKU_MCP_HTTP_PORT=9000 pnpm --filter @kohaku-ui-sample/mcp start:http
 * For UI display, run `pnpm --filter @kohaku-ui-sample/mcp build:renderer` beforehand.
 *
 * MCP 2026-07-28 / SDK v2: protocol version 2026-07-28 removed protocol-level sessions and the
 * `Mcp-Session-Id` header entirely (stateless Streamable HTTP), and `@modelcontextprotocol/server`
 * 2.0.0's `createMcpHandler` is this SDK's own stateless serving entry — a per-request `McpServer`
 * instance from `options.createServer`, with a built-in stateless fallback for still-2025-era
 * (SDK v1) clients (`legacy: "stateless"`, the default). This file used to keep its own
 * `transports` / `lastSeen` session registry (mcp-session-id -> transport, with an idle-TTL sweep)
 * targeting SDK v1's *stateful* session-management convention; that whole apparatus (the sweep
 * timer, the session-limit rejection, the `Mcp-Session-Id` header handling) is removed, not merely
 * simplified — `createMcpHandler` + `toNodeHandler` (from `@modelcontextprotocol/node`, the
 * fetch-Request/Response <-> node:http adapter) now own request routing and protocol-era
 * classification entirely. The `KOHAKU_MCP_HTTP_ALLOWED_HOSTS` DNS-rebinding-protection guard
 * (host:port exact match) is unrelated to sessions and is kept as-is: the SDK's own
 * `hostHeaderValidation` helper (from `@modelcontextprotocol/node`) validates hostname only
 * (port-agnostic), a narrower match than this app's existing host:port env-var contract, so
 * switching to it would be an observable behavior change for `KOHAKU_MCP_HTTP_ALLOWED_HOSTS` —
 * not adopted here.
 */

import { readFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";
import { createKohakuMcpSetup } from "./setup.js";

/** Path of the MCP endpoint (default). */
const MCP_PATH = "/mcp";
/** Path prefix for static snapshot serving (default). */
const SNAPSHOT_PATH = "/snapshots";
/**
 * In-memory limit on the POST body. JSON-RPC bodies are usually a few KB. Sends larger than
 * a few hundred KB are not expected, so reading is cut off at a 4 MiB limit and a 413-equivalent
 * error is returned (do not read the whole body into memory unbounded). Enforced by this app's own
 * `readJsonBody` rather than by the SDK's node adapter (`toNodeHandler`/`toWebRequest` impose no
 * body-size limit of their own) — the pre-read, size-checked body is then handed to the adapter as
 * its `parsedBody` argument, so nothing is read from `req` a second time.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Sentinel error indicating the POST body exceeded {@link MAX_BODY_BYTES} (the caller converts it to 413). */
class BodyTooLargeError extends Error {
  constructor() {
    super(`Request body exceeds the limit (${MAX_BODY_BYTES} bytes)`);
    this.name = "BodyTooLargeError";
  }
}

export interface McpHttpServerOptions {
  /** Factory that creates a fresh attached McpServer per request (usually setup.createServer). */
  createServer: () => McpServer;
  /**
   * Directory where snapshot HTML is stored (setup.snapshotDir; single source of truth).
   * GETs to `${snapshotPath}/<file>` are served statically from here (so remote MCP can open them by URL too).
   */
  snapshotDir: string;
  /** Path prefix for static snapshot serving (default /snapshots). */
  snapshotPath?: string;
  /** Path of the MCP endpoint (default /mcp). */
  path?: string;
  /**
   * Allowed hosts for DNS rebinding protection. Protection is enabled only when specified.
   * Guards a demo bound to localhost from being hit with a spoofed Host from a malicious page in a browser.
   * However, through a public tunnel the Host becomes the tunnel's domain, so it is rejected unless that host
   * is listed. Therefore protection is off by default (unspecified). To use it for localhost only,
   * pass e.g. ["localhost:8788","127.0.0.1:8788"].
   */
  allowedHosts?: string[];
}

/**
 * Judge whether a Host is allowed. Matches the host:port header exactly against `allowedHosts`
 * (case-sensitive). When allowedHosts is unset (empty), always allow (protection off = default
 * behavior). Kept as this app's own guard rather than the SDK's `hostHeaderValidation` (see this
 * file's top doc comment) — same matching semantics as before the SDK v2 migration.
 */
function isAllowedHost(host: string | undefined, allowedHosts: string[] | undefined): boolean {
  if (allowedHosts == null || allowedHosts.length === 0) return true;
  return host != null && allowedHosts.includes(host);
}

/**
 * Build a Streamable HTTP MCP server on top of node:http (no express dependency), stateless
 * (protocol version 2026-07-28 removed protocol-level sessions): `createMcpHandler` builds a fresh
 * `McpServer` from `options.createServer` for each exchange (each legacy/2025-era request, or each
 * modern/2026-era request), so there is no session state to route on. Since it is hit from browser
 * hosts (claude.ai / ChatGPT), CORS and OPTIONS are handled.
 *
 * Does not listen (the caller decides the port and listens). A pure factory so it can be reused from tests.
 */
export function createMcpHttpServer(options: McpHttpServerOptions): Server {
  const path = options.path ?? MCP_PATH;
  const snapshotPath = options.snapshotPath ?? SNAPSHOT_PATH;
  const dnsProtection = (options.allowedHosts?.length ?? 0) > 0;

  // One handler for the whole server's lifetime (not "per session" — createMcpHandler itself builds a
  // fresh per-request McpServer instance from options.createServer). onerror observes failures the
  // fetch-level handler itself reports (routing/dispatch failures); toNodeHandler's own onerror below
  // observes the narrower node<->fetch adapter failures (request conversion, handler.fetch throwing).
  // Production hook: this demo's setup.createServer leaves McpHostDeps.resolvePrincipal unwired (every
  // call runs as the anonymous principal) — this per-request createServer() call is exactly where a real
  // deployment would derive the caller's identity (e.g. from this request's own auth) and wire it in.
  const mcpHandler = createMcpHandler(() => options.createServer(), {
    onerror: (err) => console.error("[kohaku-mcp-http] MCP handler error:", err),
  });
  const handleMcp = toNodeHandler(mcpHandler, {
    onerror: (err) => console.error("[kohaku-mcp-http] node adapter error:", err),
  });

  const httpServer = createHttpServer(async (req, res) => {
    applyCors(res);
    // Browser preflight. Return only the CORS headers and finish.
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    // DNS rebinding protection: when allowedHosts is set, validate the Host header at a common point
    // before routing (snapshot / mcp). This also protects the static snapshot serving that bypasses the
    // MCP handler's own routing. When unset (default), this branch is not taken and behavior is unchanged.
    if (dnsProtection && !isAllowedHost(req.headers.host, options.allowedHosts)) {
      sendJsonError(res, 403, -32000, `Invalid Host header: ${req.headers.host ?? ""}`);
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Static snapshot serving (so remote MCP can open them by URL too). Branch before the /mcp check.
    // GET only and only when starting with `${snapshotPath}/`. The last segment is basename-validated and confined to snapshotDir.
    if (req.method === "GET" && url.pathname.startsWith(`${snapshotPath}/`)) {
      await serveSnapshot(res, options.snapshotDir, url.pathname.slice(snapshotPath.length + 1));
      return;
    }

    if (url.pathname !== path) {
      sendJsonError(res, 404, -32601, `Not found: ${url.pathname}`);
      return;
    }

    try {
      if (req.method === "POST") {
        // Pre-read the body under this app's own size limit (see MAX_BODY_BYTES's doc comment), then
        // hand it to the SDK's node adapter as parsedBody so it reads nothing from req itself.
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          if (err instanceof BodyTooLargeError) {
            // Close the connection after the response since we cut off reading the rest (Connection: close).
            res.setHeader("Connection", "close");
            sendJsonError(res, 413, -32000, err.message);
            return;
          }
          throw err; // JSON parse failures etc. are delegated to the outer catch (500)
        }
        await handleMcp(req, res, body);
        return;
      }

      // GET (standalone SSE stream) and DELETE (session end) are 2025-era session operations with no
      // stateless equivalent — createMcpHandler's default legacy:"stateless" answers both with 405, the
      // same way protocol-level sessions being removed makes them meaningless under 2026-era serving.
      // Any other method (HEAD, PUT, ...) is likewise left to the handler's own routing/rejection.
      await handleMcp(req, res);
    } catch (err) {
      console.error("[kohaku-mcp-http] Error while handling request:", err);
      if (!res.headersSent) sendJsonError(res, 500, -32603, "Internal error");
    }
  });

  // On server stop, tear down the modern-era leg (aborts in-flight modern exchanges and closes their
  // per-request instances; the legacy stateless fallback holds nothing between exchanges to close).
  httpServer.on("close", () => {
    void mcpHandler.close();
  });

  return httpServer;
}

/** CORS headers so browser MCP hosts can hit us (allow-all for the demo). */
function applyCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  // mcp-protocol-version is a custom header the SDK's modern-era classification reads from the browser
  // request, so allow it explicitly (mcp-session-id is no longer part of the wire contract — protocol
  // version 2026-07-28 removed protocol-level sessions).
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, mcp-protocol-version, Last-Event-ID",
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJsonError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function sendPlainError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

/**
 * Static serving of snapshot HTML (so remote MCP can open them by URL too).
 * Path traversal is defended in layers: (1) decode the last segment → basename validation (reject
 * anything containing separators `/`, `\`, parent references `..`, or NUL), (2) confirm the resolved
 * target stays under snapshotDir.
 * The self-contained HTML (with inline script) is opened as a normal document, so **no CSP is attached**.
 * ⚠️ No auth: anyone who knows this URL can view the snapshot (real data inlined) (demo policy).
 */
async function serveSnapshot(res: ServerResponse, snapshotDir: string, rawName: string): Promise<void> {
  let name: string;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    sendPlainError(res, 400, "Invalid file name");
    return;
  }
  // Basename validation (first line of defense): do not serve anything containing path separators, parent references, or NUL.
  if (
    name === "" ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..") ||
    name.includes("\0")
  ) {
    sendPlainError(res, 400, "Invalid file name");
    return;
  }
  // Confirm the resolved target stays under snapshotDir (defense in depth).
  const dir = resolve(snapshotDir);
  const full = resolve(dir, name);
  if (full !== dir && !full.startsWith(dir + sep)) {
    sendPlainError(res, 400, "Invalid file name");
    return;
  }
  let body: Buffer;
  try {
    body = await readFile(full);
  } catch {
    sendPlainError(res, 404, "Snapshot not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.byteLength,
  });
  res.end(body);
}

/**
 * Read the POST body to completion and parse it as JSON. An empty body is undefined.
 * Limit the body size to {@link MAX_BODY_BYTES}. Overflow is detected both by the Content-Length
 * pre-check and by the cumulative check during stream reception; on overflow, reception is cut off
 * and {@link BodyTooLargeError} is thrown (the caller converts it into a 413-equivalent error).
 * It is written with event subscription rather than for-await so that, on overflow detection, the
 * subscription can be canceled midway to stop the rest of reception (so nothing more piles up in memory).
 * Exported so the two size-limit branches (Content-Length pre-check / cumulative) can be verified deterministically.
 */
export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Content-Length pre-check (if the sender is honest, we can reject before reception).
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      req.pause();
      reject(new BodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      total += chunk.byteLength;
      // Cumulative size exceeds the limit. Stop reception and cut off (the rest is discarded by the caller's Connection: close).
      if (total > MAX_BODY_BYTES) {
        settled = true;
        cleanup();
        req.pause();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw === "") {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    };
    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/** Parse the comma-separated allowed-hosts env (undefined if empty = protection off). Exported for testability. */
export function parseAllowedHosts(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const hosts = value
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h !== "");
  return hosts.length > 0 ? hosts : undefined;
}

async function main(): Promise<void> {
  const port = Number(process.env["KOHAKU_MCP_HTTP_PORT"] ?? 8788);
  // Base URL for publishing snapshots. When using a public tunnel, set it to the tunnel's URL.
  // If unset, falls back to localhost (local viewing only). The trailing slash is stripped.
  const publicUrl = process.env["KOHAKU_MCP_PUBLIC_URL"]?.replace(/\/+$/, "") ?? `http://localhost:${port}`;
  const setup = await createKohakuMcpSetup({ snapshotBaseUrl: publicUrl });
  const allowedHosts = parseAllowedHosts(process.env["KOHAKU_MCP_HTTP_ALLOWED_HOSTS"]);
  const httpServer = createMcpHttpServer({
    createServer: setup.createServer,
    snapshotDir: setup.snapshotDir,
    allowedHosts,
  });

  // By default, bind to 127.0.0.1 (local only). Without a host specified, Node binds to 0.0.0.0 / ::,
  // which would unintentionally expose the no-auth demo to the LAN. Only when LAN / container exposure is
  // needed, override explicitly with e.g. KOHAKU_MCP_HTTP_HOST=0.0.0.0 (steer external exposure toward the
  // KOHAKU_MCP_PUBLIC_URL + tunnel path).
  const host = process.env["KOHAKU_MCP_HTTP_HOST"] ?? "127.0.0.1";
  httpServer.listen(port, host, () => {
    console.error(
      `kohaku-sales-sample MCP server: ready (Streamable HTTP) at http://${host}:${port}${MCP_PATH}`,
    );
    console.error(`  LLM: ${setup.llm.provider} / ${setup.llm.modelId}`);
    console.error(
      `  Snapshot serving: ${publicUrl}${SNAPSHOT_PATH}/<file> (kohaku_render_snapshot returns this URL)`,
    );
    console.error(
      `  bind: ${host}:${port} (default 127.0.0.1 = local only. For LAN / container exposure, override explicitly with KOHAKU_MCP_HTTP_HOST=0.0.0.0)`,
    );
    console.error(
      "  ⚠️ No authentication (demo). Anyone who knows the URL can view and operate the sales data, and anyone who knows a snapshot URL can view HTML with real data inlined.",
    );
    console.error(
      `  When sharing via a public tunnel (ngrok / cloudflared, etc.), set KOHAKU_MCP_PUBLIC_URL to the tunnel URL (if unset, the local URL ${publicUrl} is returned and cannot be opened externally), and hand the URL only to trusted parties.`,
    );
    if (allowedHosts) {
      console.error(`  DNS rebinding protection: enabled (allowedHosts=${allowedHosts.join(", ")})`);
    } else {
      console.error(
        "  DNS rebinding protection: disabled (enable by listing allowed hosts in KOHAKU_MCP_HTTP_ALLOWED_HOSTS)",
      );
    }
  });

  // Graceful shutdown: closing the server fires the 'close' cleanup above (tearing down the modern leg).
  // Open SSE stream(s) mid-response may hold the server open, so a bounded drain window
  // (KOHAKU_SHUTDOWN_GRACE_MS, default 30s) precedes a forced exit. A clean drain exits 0; a forced one
  // logs the number of connections still open and exits 1 (distinguishable in orchestrator logs). This
  // server has no dedicated health endpoint today (unlike sample-api's GET /api/health), so there is no
  // readiness flag to flip here — a load balancer in front of this demo server would need to probe the
  // MCP endpoint itself or be told out-of-band.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      const graceMs = shutdownGraceMs();
      console.error(
        `kohaku-sales-sample MCP server: received ${signal}, draining connections (grace ${graceMs}ms)`,
      );
      // Close idle keep-alive sockets immediately rather than waiting for their keep-alive timeout to
      // elapse: close() alone only stops accepting *new* connections and waits for every existing one
      // (idle or not) to end before its callback fires, so an idle client sitting on a keep-alive
      // connection would otherwise stall the drain for no reason.
      httpServer.closeIdleConnections();
      httpServer.close(() => process.exit(0));
      setTimeout(() => {
        httpServer.getConnections((err, count) => {
          console.error(
            `kohaku-sales-sample MCP server: shutdown grace period (${graceMs}ms) elapsed with ` +
              `${err != null ? "an unknown number of" : count} connection(s) still open; forcing exit`,
          );
          process.exit(1);
        });
      }, graceMs).unref();
    });
  }
}

/** Default drain window (ms) for graceful shutdown, overridable via KOHAKU_SHUTDOWN_GRACE_MS. */
const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;

/** Parses KOHAKU_SHUTDOWN_GRACE_MS as a positive integer; any other value (unset, non-numeric, <= 0) falls back to the default. */
function shutdownGraceMs(): number {
  const raw = process.env["KOHAKU_SHUTDOWN_GRACE_MS"];
  const parsed = raw != null ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SHUTDOWN_GRACE_MS;
}

// Start listening only when this file is launched directly (tsx src/http.ts).
// When imported (e.g. from tests), it just exports createMcpHttpServer with no side effects.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main();
}

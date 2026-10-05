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
 * classification entirely. DNS-rebinding protection (Host + Origin validation, on by default for the localhost
 * names, extended with `KOHAKU_MCP_ALLOWED_HOSTS` / `KOHAKU_MCP_ALLOWED_ORIGINS`) uses the SDK's
 * `hostHeaderValidation` / `originValidation` guards, the same ones `kohaku init --mcp`'s generated server uses.
 */

import { readFile } from "node:fs/promises";
import type { Server, ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMcpHttpServer as createMcpHttpScaffold,
  DEFAULT_MAX_BODY_BYTES,
} from "@kohaku-ui/host/mcp-http";
// The graceful-shutdown handler is shared with sample-api's index.ts (@kohaku-ui-sample/api/app/shutdown) --
// see that module's own doc comment for why it lives there and why this subpath is framework-free (no hono
// / host-rest import), so importing it here does not pull the REST framework into this profile.
import { createGracefulShutdownHandler, shutdownGraceMs } from "@kohaku-ui-sample/api/app/shutdown";
import type { McpServer } from "@modelcontextprotocol/server";
import { createKohakuMcpSetup, type KohakuMcpSetup } from "./setup.js";

// The size-limited body reader lives with the shared scaffold; re-exported so its size-limit branches stay
// verifiable from this entry point's tests.
export { readJsonBody } from "@kohaku-ui/host/mcp-http";

/** Path of the MCP endpoint (default). */
const MCP_PATH = "/mcp";
/** Path prefix for static snapshot serving (default). */
const SNAPSHOT_PATH = "/snapshots";

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
   * Extra hostnames accepted in the `Host` header (DNS rebinding protection), on top of the always-allowed
   * `localhost` / `127.0.0.1` / `[::1]`. Hostnames only: a `:port` suffix is ignored (the SDK's guard is
   * port-agnostic). Through a public tunnel or reverse proxy the Host is the tunnel's domain, so it must be
   * listed here. Every request is validated; an unlisted Host is rejected with 403 before routing.
   */
  allowedHosts?: string[];
  /**
   * Extra origin hostnames accepted in the `Origin` header, on top of the always-allowed localhost names. A
   * request without an Origin (non-browser MCP clients) passes; one from an unlisted origin is rejected with
   * 403, and the CORS headers echo only an origin that passed this check (never `*`).
   */
  allowedOrigins?: string[];
}

/**
 * The bare hostname of an allow-list entry, as the SDK's guards expect it: a leading scheme and a trailing
 * `:port` are dropped (`https://x.example:8443` and `x.example:8443` both become `x.example`; `[::1]:8788`
 * becomes `[::1]`). Exported for testability.
 */
export function allowedHostnameOf(entry: string): string {
  const withoutScheme = entry.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const authority = withoutScheme.split("/")[0] ?? "";
  if (authority.startsWith("[")) return authority.replace(/\]:\d+$/, "]");
  return authority.replace(/:\d+$/, "");
}

/**
 * Build this app's Streamable HTTP MCP server: the shared scaffold (`./mcp-http-server.ts` — Host / Origin
 * guards, CORS, body cap, stateless `createMcpHandler`) plus this entry point's own behavior, passed as
 * options so the wire answers stay exactly what they were: the static snapshot route, a 404 for any other
 * path, JSON-RPC 500 / -32603 for a malformed body or an unexpected failure, the extra `Last-Event-ID` /
 * `Access-Control-Max-Age` CORS entries, and `[kohaku-mcp-http]`-prefixed error logs.
 *
 * Does not listen (the caller decides the port and listens). A pure factory so it can be reused from tests.
 */
export function createMcpHttpServer(options: McpHttpServerOptions): Server {
  const snapshotPath = options.snapshotPath ?? SNAPSHOT_PATH;
  const internalError = { status: 500, code: -32603, message: "Internal error" };
  return createMcpHttpScaffold({
    createServer: options.createServer,
    path: options.path ?? MCP_PATH,
    allowedHosts: (options.allowedHosts ?? []).map(allowedHostnameOf),
    allowedOrigins: (options.allowedOrigins ?? []).map(allowedHostnameOf),
    bodyTooLargeMessage: `Request body exceeds the limit (${DEFAULT_MAX_BODY_BYTES} bytes)`,
    corsAllowHeaders: ["Last-Event-ID"],
    corsMaxAgeSeconds: 86400,
    invalidJson: internalError,
    internalError,
    // Static snapshot serving (so remote MCP can open them by URL too). Tried before the /mcp path check.
    // GET only and only when starting with `${snapshotPath}/`. The last segment is basename-validated and confined to snapshotDir.
    routes: async (req, res, url) => {
      if (req.method === "GET" && url.pathname.startsWith(`${snapshotPath}/`)) {
        await serveSnapshot(res, options.snapshotDir, url.pathname.slice(snapshotPath.length + 1));
        return true;
      }
      return false;
    },
    onError: (stage, err) => {
      if (stage === "handler") console.error("[kohaku-mcp-http] MCP handler error:", err);
      else if (stage === "adapter") console.error("[kohaku-mcp-http] node adapter error:", err);
      else console.error("[kohaku-mcp-http] Error while handling request:", err);
    },
  });
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

/** Parse a comma-separated allow-list env value (undefined if empty). Exported for testability. */
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
  // Storage/authz (and, under KOHAKU_AUTHZ=jwt, the per-tool-call resolvePrincipal built from the request's
  // own bearer token) are entirely setup.ts's responsibility now — this entry point no longer resolves authz
  // on its own, so there is exactly one AuthzPort (and, when applicable, one shared storage/revocation
  // connection) for the whole process, not a second one redundantly built here.
  const setup = await createKohakuMcpSetup({ snapshotBaseUrl: publicUrl });
  // Fail fast: with a redis/postgres backend, an unreachable server otherwise surfaces only on the first
  // tool call (or, before storage-redis's fail-fast fix, hangs the caller indefinitely). Exit clearly here
  // instead (a no-op for file/memory -- see PortsFromEnv.ready's doc comment).
  try {
    await setup.ready();
  } catch (error) {
    console.error(
      `kohaku-sales-sample MCP server: storage backend is not ready: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  // KOHAKU_MCP_HTTP_ALLOWED_HOSTS is the former name of KOHAKU_MCP_ALLOWED_HOSTS (kept as a deprecated alias).
  const deprecatedHosts = parseAllowedHosts(process.env["KOHAKU_MCP_HTTP_ALLOWED_HOSTS"]);
  if (deprecatedHosts != null) {
    console.error(
      "kohaku-sales-sample MCP server: KOHAKU_MCP_HTTP_ALLOWED_HOSTS is deprecated, use KOHAKU_MCP_ALLOWED_HOSTS",
    );
  }
  const allowedHosts = [
    ...(parseAllowedHosts(process.env["KOHAKU_MCP_ALLOWED_HOSTS"]) ?? []),
    ...(deprecatedHosts ?? []),
  ];
  const allowedOrigins = parseAllowedHosts(process.env["KOHAKU_MCP_ALLOWED_ORIGINS"]) ?? [];
  const httpServer = createMcpHttpServer({
    createServer: setup.createServer,
    snapshotDir: setup.snapshotDir,
    allowedHosts,
    allowedOrigins,
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
    console.error(
      `  DNS rebinding protection: enabled (Host / Origin: localhost, 127.0.0.1, [::1]${
        allowedHosts.length > 0 ? `; extra hosts: ${allowedHosts.join(", ")}` : ""
      }${allowedOrigins.length > 0 ? `; extra origins: ${allowedOrigins.join(", ")}` : ""})`,
    );
    console.error(
      "  Behind a public tunnel the Host is the tunnel's domain: add it with KOHAKU_MCP_ALLOWED_HOSTS=<name> (and a browser caller's origin with KOHAKU_MCP_ALLOWED_ORIGINS=<name>)",
    );
  });

  // Graceful shutdown: closing the server fires the 'close' cleanup above (tearing down the modern leg).
  // Open SSE stream(s) mid-response may hold the server open, so a bounded drain window
  // (KOHAKU_SHUTDOWN_GRACE_MS, default 30s) precedes a forced exit. A clean drain exits 0; a forced one
  // logs the number of connections still open and exits 1 (distinguishable in orchestrator logs). This
  // server has no dedicated health endpoint today (unlike sample-api's GET /api/health), so there is no
  // readiness flag to flip here — a load balancer in front of this demo server would need to probe the
  // MCP endpoint itself or be told out-of-band. The handler itself is shared with sample-api's index.ts
  // (see buildShutdownHandler's own doc comment).
  const handleShutdown = buildShutdownHandler(httpServer, setup);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => handleShutdown(signal));
  }
}

/**
 * Builds this entry point's SIGINT/SIGTERM handler from the shared graceful-shutdown machinery
 * (`@kohaku-ui-sample/api/app/shutdown`, also used by sample-api's own `index.ts`): no readiness flag to
 * flip here (this server has no health endpoint — see `main`'s own doc comment above) and no pre-stop
 * wait, just drain-then-close, with the forced-exit path's bounded best-effort close.
 * Exported (rather than inlined into `main`) so a test can prove this entry point wires the shared
 * handler with the right `ports`/`graceMs`/`label` without re-testing the handler's own sequencing
 * (already covered once by sample-api's own shutdown tests).
 */
export function buildShutdownHandler(
  server: Server,
  setup: Pick<KohakuMcpSetup, "close">,
): (signal: string) => void {
  return createGracefulShutdownHandler({
    server,
    ports: setup,
    graceMs: shutdownGraceMs(),
    label: "kohaku-sales-sample MCP server",
  });
}

// Start listening only when this file is launched directly (tsx src/http.ts).
// When imported (e.g. from tests), it just exports createMcpHttpServer with no side effects.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main();
}

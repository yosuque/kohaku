/**
 * `@kohaku-ui/host/mcp-http`: the shared Streamable-HTTP scaffold for an MCP server -- Host / Origin guards
 * (DNS rebinding protection), echoed-Origin CORS, the OPTIONS preflight, a size-capped body pre-read, and the
 * stateless `createMcpHandler` + `toNodeHandler` wiring. It owns nothing product-specific (no static routes, no
 * env parsing, no shutdown): the caller supplies those through the options below and decides the port.
 *
 * A separate subpath rather than part of `./mcp` because it needs `node:http` and `@modelcontextprotocol/node`
 * (plus `@modelcontextprotocol/server`'s `createMcpHandler`), and a `./mcp` consumer that attaches to its own
 * transport must not be forced to install `@modelcontextprotocol/node`. Both are optional peer dependencies of
 * this package, needed only for this subpath; neither `src/index.ts` nor `src/mcp.ts` imports this module.
 *
 * Defaults follow the server `kohaku init --mcp` generates (400 / -32700 on a malformed body, only the four
 * standard CORS headers, every path served by the MCP handler); every place where a product answers
 * differently (sample-mcp's `http.ts` does) is an explicit option, so nothing is unified silently.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";

/** Default in-memory limit on the POST body (4 MiB). JSON-RPC bodies are usually a few KB. */
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** The always-allowed Host / Origin hostnames (DNS rebinding protection). */
const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

/** Sentinel error indicating the POST body exceeded the limit (the caller converts it to 413). */
export class BodyTooLargeError extends Error {
  constructor(maxBodyBytes: number = DEFAULT_MAX_BODY_BYTES) {
    super(`Request body exceeds the limit (${maxBodyBytes} bytes)`);
    this.name = "BodyTooLargeError";
  }
}

/** A JSON-RPC error answer: the HTTP status plus the `error.code` / `error.message` of the body. */
export interface McpHttpErrorReply {
  status: number;
  code: number;
  message: string;
}

/** Where a failure reported through {@link McpHttpServerOptions.onError} happened. */
export type McpHttpErrorStage = "handler" | "adapter" | "request";

export interface McpHttpServerOptions {
  /** Factory that creates a fresh attached McpServer per request. */
  createServer: () => McpServer | Promise<McpServer>;
  /**
   * Path of the MCP endpoint. When set, any other path is answered with a 404 JSON-RPC error
   * (`-32601`, `Not found: <pathname>`) unless a route claimed it. When unset, every path reaches the MCP handler.
   */
  path?: string;
  /**
   * Extra hostnames accepted in the `Host` header, on top of the always-allowed `localhost` / `127.0.0.1` /
   * `[::1]`. Bare hostnames as the SDK's guard expects them (no scheme, no port); the helper does no
   * normalization and no env reads.
   */
  allowedHosts: readonly string[];
  /** Extra hostnames accepted in the `Origin` header, on top of the always-allowed localhost names. Same shape as `allowedHosts`. */
  allowedOrigins: readonly string[];
  /** Limit on the POST body (default 4 MiB). */
  maxBodyBytes?: number;
  /** Message of the 413 answer for an over-limit body (default `Request body too large`). */
  bodyTooLargeMessage?: string;
  /** Headers appended to the default `Access-Control-Allow-Headers` list (`Content-Type, Accept, Authorization, mcp-protocol-version`). */
  corsAllowHeaders?: readonly string[];
  /** When set, emits `Access-Control-Max-Age` with this value (seconds). */
  corsMaxAgeSeconds?: number;
  /** Answer for a POST body that cannot be read or parsed as JSON (default 400 / -32700 `Parse error`). */
  invalidJson?: McpHttpErrorReply;
  /** Answer for an unexpected failure while handling a request (default: a bare 500 with no body). */
  internalError?: McpHttpErrorReply;
  /**
   * Tried before the MCP path, after the Host / Origin guards, CORS and the preflight; return true when the
   * request was answered (e.g. static serving). The parsed request URL is passed as the third argument.
   */
  routes?: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean | Promise<boolean>;
  /**
   * Observes failures: the MCP handler's own `onerror` (`"handler"`), the node adapter's `onerror`
   * (`"adapter"`) and an unexpected failure while handling a request, including an unreadable or malformed
   * POST body (`"request"`). When unset, the SDK defaults apply for the first two and a `"request"` failure
   * is logged to stderr as `[mcp-http] request failed:`.
   */
  onError?: (stage: McpHttpErrorStage, error: unknown) => void;
}

/**
 * Build a Streamable HTTP MCP server on top of node:http (no express dependency), stateless
 * (protocol version 2026-07-28 removed protocol-level sessions): `createMcpHandler` builds a fresh
 * `McpServer` from `options.createServer` for each exchange, so there is no session state to route on.
 * Since it is hit from browser hosts (claude.ai / ChatGPT), CORS and OPTIONS are handled.
 *
 * Does not listen (the caller decides the port and listens). Closing the returned server also tears down the
 * MCP handler (aborts in-flight modern-era exchanges and closes their per-request instances).
 */
export function createMcpHttpServer(options: McpHttpServerOptions): Server {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const invalidJson = options.invalidJson ?? { status: 400, code: -32700, message: "Parse error" };
  const bodyTooLargeMessage = options.bodyTooLargeMessage ?? "Request body too large";
  const allowHeaders = [
    "Content-Type",
    "Accept",
    "Authorization",
    "mcp-protocol-version",
    ...(options.corsAllowHeaders ?? []),
  ].join(", ");
  // DNS rebinding protection is always on: localhost names by default, plus whatever the caller lists.
  const validateHost = hostHeaderValidation([...LOCAL_HOSTNAMES, ...options.allowedHosts]);
  const validateOrigin = originValidation([...LOCAL_HOSTNAMES, ...options.allowedOrigins]);

  const { onError } = options;
  // One handler for the whole server's lifetime (createMcpHandler itself builds a fresh per-request McpServer
  // from options.createServer). The handler's onerror observes failures it reports itself (routing/dispatch);
  // toNodeHandler's onerror observes the narrower node<->fetch adapter failures.
  const mcpHandler = createMcpHandler(
    () => options.createServer(),
    onError ? { onerror: (err) => onError("handler", err) } : undefined,
  );
  const handleMcp = toNodeHandler(
    mcpHandler,
    onError ? { onerror: (err) => onError("adapter", err) } : undefined,
  );

  const reportRequestError = (err: unknown): void => {
    if (onError) onError("request", err);
    else console.error("[mcp-http] request failed:", err);
  };

  const httpServer = createHttpServer(async (req, res) => {
    // DNS rebinding / CSRF protection, at a common point before routing so it also guards any route that
    // bypasses the MCP handler's own routing. Each guard has already answered with a 403 when it returns false.
    if (!validateHost(req, res)) return;
    if (!validateOrigin(req, res)) return;
    applyCors(req, res, allowHeaders, options.corsMaxAgeSeconds);
    // Browser preflight. Return only the CORS headers and finish.
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    if (options.routes != null || options.path != null) {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (options.routes != null && (await options.routes(req, res, url))) return;
      if (options.path != null && url.pathname !== options.path) {
        sendJsonError(res, { status: 404, code: -32601, message: `Not found: ${url.pathname}` });
        return;
      }
    }

    try {
      if (req.method === "POST") {
        // Pre-read the body under the size limit, then hand it to the SDK's node adapter as parsedBody so
        // it reads nothing from req itself (the adapter imposes no body-size limit of its own).
        let body: unknown;
        try {
          body = await readJsonBody(req, maxBodyBytes);
        } catch (err) {
          if (err instanceof BodyTooLargeError) {
            // Close the connection after the response since we cut off reading the rest (Connection: close).
            res.setHeader("Connection", "close");
            sendJsonError(res, { status: 413, code: -32000, message: bodyTooLargeMessage });
            return;
          }
          if (onError) onError("request", err);
          sendJsonError(res, invalidJson);
          return;
        }
        await handleMcp(req, res, body);
        return;
      }

      // GET (standalone SSE stream) and DELETE (session end) are 2025-era session operations with no
      // stateless equivalent — createMcpHandler's default legacy:"stateless" answers both with 405.
      // Any other method (HEAD, PUT, ...) is likewise left to the handler's own routing/rejection.
      await handleMcp(req, res);
    } catch (err) {
      reportRequestError(err);
      if (!res.headersSent) {
        if (options.internalError) sendJsonError(res, options.internalError);
        else res.writeHead(500).end();
      }
    }
  });

  // On server stop, tear down the modern-era leg (aborts in-flight modern exchanges and closes their
  // per-request instances; the legacy stateless fallback holds nothing between exchanges to close).
  httpServer.on("close", () => {
    void mcpHandler.close();
  });

  return httpServer;
}

/**
 * CORS headers so browser MCP hosts can hit us. Only an Origin that already passed `originValidation` is ever
 * echoed back (with `Vary: Origin`); a request with no Origin gets no CORS headers at all, never `*`.
 */
function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  allowHeaders: string,
  maxAgeSeconds: number | undefined,
): void {
  const origin = req.headers.origin;
  if (origin == null) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  // mcp-protocol-version is a custom header the SDK's modern-era classification reads from the browser
  // request, so it is part of the default list (mcp-session-id is no longer part of the wire contract —
  // protocol version 2026-07-28 removed protocol-level sessions).
  res.setHeader("Access-Control-Allow-Headers", allowHeaders);
  if (maxAgeSeconds != null) res.setHeader("Access-Control-Max-Age", String(maxAgeSeconds));
}

function sendJsonError(res: ServerResponse, { status, code, message }: McpHttpErrorReply): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/**
 * Read the POST body to completion and parse it as JSON. An empty body is undefined.
 * Limit the body size to `maxBodyBytes`. Overflow is detected both by the Content-Length
 * pre-check and by the cumulative check during stream reception; on overflow, reception is cut off
 * and {@link BodyTooLargeError} is thrown (the caller converts it into a 413 answer).
 * It is written with event subscription rather than for-await so that, on overflow detection, the
 * subscription can be canceled midway to stop the rest of reception (so nothing more piles up in memory).
 * Exported so the two size-limit branches (Content-Length pre-check / cumulative) can be verified deterministically.
 */
export function readJsonBody(
  req: IncomingMessage,
  maxBodyBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Content-Length pre-check (if the sender is honest, we can reject before reception).
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      req.pause();
      reject(new BodyTooLargeError(maxBodyBytes));
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
      if (total > maxBodyBytes) {
        settled = true;
        cleanup();
        req.pause();
        reject(new BodyTooLargeError(maxBodyBytes));
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

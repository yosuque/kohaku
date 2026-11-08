---
"@kohaku-ui/cli": patch
---

The `server/mcp-http.ts` that `kohaku init --mcp` generates is now built on `createMcpHttpServer` from `@kohaku-ui/host/mcp-http` instead of carrying its own copy of the Host / Origin guards, CORS, body cap and stateless handler. The `.env` loading, `PORT` / `HOST`, `KOHAKU_MCP_ALLOWED_HOSTS` / `KOHAKU_MCP_ALLOWED_ORIGINS` and graceful shutdown stay in the generated file. Two observable differences: the server now serves only `/mcp` (any other path answers a 404 JSON-RPC error; previously every path reached the MCP handler, so `/mcp/` with a trailing slash and a reverse proxy that serves it under a path prefix now get a 404 and need to forward to `/mcp`), and a malformed POST body no longer gets a `Connection: close` header on its 400 answer (an oversized body's 413 still does). The generated README now gives the full URL, `http://127.0.0.1:8788/mcp`. The generated server also prints a one-line hint when the port is already in use.

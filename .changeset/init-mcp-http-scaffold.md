---
"@kohaku-ui/cli": patch
---

The `server/mcp-http.ts` that `kohaku init --mcp` generates is now built on `createMcpHttpServer` from `@kohaku-ui/host/mcp-http` instead of carrying its own copy of the Host / Origin guards, CORS, body cap and stateless handler. The `.env` loading, `PORT` / `HOST`, `KOHAKU_MCP_ALLOWED_HOSTS` / `KOHAKU_MCP_ALLOWED_ORIGINS` and graceful shutdown stay in the generated file. Two observable differences: the server now serves only `/mcp` (any other path answers a 404 JSON-RPC error; previously every path reached the MCP handler), and a malformed or oversized POST body no longer gets a `Connection: close` header on its 400 / 413 answer. The README already points clients at `/mcp`, so no client change is needed.

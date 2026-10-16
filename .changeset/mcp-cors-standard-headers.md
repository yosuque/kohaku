---
"@kohaku-ui/host": patch
"@kohaku-ui/cli": patch
---

MCP Streamable HTTP CORS: the preflight now also allows the standard `mcp-method` and `mcp-name` request headers (SEP-2243). The MCP SDK client sends them on modern-era requests and the server's HTTP entry validates them, so a cross-origin browser caller was rejected at the preflight before. This applies to `createMcpHttpServer` (`@kohaku-ui/host/mcp-http`) and to the server `kohaku init --mcp` generates. `Mcp-Param-<Name>` headers (sent only for tools declaring `x-mcp-header`) are not in the default list because a CORS allow-list cannot wildcard a prefix; a product that declares one adds it through the `corsAllowHeaders` option.

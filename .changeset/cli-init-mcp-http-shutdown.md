---
"@kohaku-ui/cli": patch
---

The MCP Streamable HTTP server that `kohaku init --mcp` generates now shuts down gracefully on SIGINT / SIGTERM and documents that its Origin check is port-agnostic; `kohaku migrate --catalog` adds a hint (pass a built `.js`, or run under tsx) when the catalog module cannot be imported on plain Node.

---
"@kohaku-ui/host-mcp-apps": patch
---

The MCP rate-limit bucket key doc no longer claims a session id exists on Streamable HTTP (the stateless `createMcpHandler` serving has none, so every caller shared the `"anonymous"` bucket): a rate limiter wired without `resolvePrincipal` or the new `rateLimitKey(extra)` hook now warns once at attach, and a new `onRateLimited` observer reports denials. The correlation id of a session-less call is now `mcp:<per-call uuid>:<jsonrpc id>` instead of the colliding `mcp:<jsonrpc id>`.

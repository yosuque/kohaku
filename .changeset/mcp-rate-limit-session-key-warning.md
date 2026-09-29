---
"@kohaku-ui/host-mcp-apps": patch
---

The one-time warning for a `rateLimiter` wired without `resolvePrincipal` or `rateLimitKey` now also says that on a stateful transport the per-session bucket can be shed by opening a new session, and the `McpHostDeps.rateLimiter` docs recommend `rateLimitKey` / `resolvePrincipal` in production.

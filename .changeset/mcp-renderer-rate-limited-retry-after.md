---
"@kohaku-ui/mcp-renderer": patch
---

The MCP renderer boot now maps a structured `RATE_LIMITED` tool error from `kohaku_resolve_binding` and `kohaku_action` to a `BindingError("RATE_LIMITED", ..., { retryAfterMs })`, the same as data-binding's REST client does for a 429, instead of a generic 403 / plain `Error` that dropped the retry hint (SPEC §6.1, REST-RL-001).

---
"@kohaku-ui/host-mcp-apps": patch
"@kohaku-ui/host-core": patch
---

`McpHostDeps.onError` now receives an optional `correlationId` (the call's `mcp:...` id, the same value lineage events and `_meta["kohaku/requestId"]` carry) when the failing path has a tool call in hand, matching the Python port's `McpErrorInfo`. `createConsoleErrorReporter().mcp` prints it as `(correlation <id>)`.

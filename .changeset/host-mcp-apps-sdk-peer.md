---
"@kohaku-ui/host-mcp-apps": patch
---

Declare `@modelcontextprotocol/server` as a peer dependency instead of a regular dependency. `attachKohakuToMcpServer` attaches to the `McpServer` the application constructs, so the application and kohaku must share one copy of the SDK (the same rule this workspace already applies to `zod`). Add `@modelcontextprotocol/server` to your own dependencies if it is not there yet.

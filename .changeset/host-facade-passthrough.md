---
"@kohaku-ui/host": patch
"@kohaku-ui/host-core": patch
---

`createKohakuHost` now records every compose into View Lineage by default (`recorder`, exposed with `lineage` on the returned host), passes every other `KohakuHostDeps` field through a new `routes` option, and forwards `fallbackIntent` / `rules` to the default SemanticPort. `attachKohakuMcp` gains a `deps` option for `McpHostDeps`, and defaults the MCP profile's `onError` (via the new `createConsoleErrorReporter(...).mcp`) and `recorder`, as design.md decision 52 describes.

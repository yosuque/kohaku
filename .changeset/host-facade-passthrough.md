---
"@kohaku-ui/host": patch
"@kohaku-ui/host-core": patch
---

`createKohakuHost` now records every compose into View Lineage and every governed-Action outcome into `action.*` events by default (`recorder` / `actionAuditRecorder`, each disabled with `false`, exposed with `lineage` on the returned host), passes every other `KohakuHostDeps` field through a new `routes` option, and forwards `fallbackIntent` / `rules` to the default SemanticPort. `attachKohakuMcp` gains a `deps` option for `McpHostDeps`, and defaults the MCP profile's `onError` (via the new `createConsoleErrorReporter(...).mcp`), `recorder` and `actionAuditRecorder`, as design.md decision 52 describes.

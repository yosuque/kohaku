---
"@kohaku-ui/mcp-renderer": patch
---

`bootMcpRenderer` accepts a `disclosure` option (`"off"` | `"attributes"` | `"label"`, default `"off"`) that is passed to `SpecView`, so the AI-generation disclosure of design.md decision 66 can be switched on in the MCP Apps widget. The default leaves the rendered DOM unchanged.

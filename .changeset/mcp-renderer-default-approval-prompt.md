---
"@kohaku-ui/mcp-renderer": patch
---

The MCP Apps renderer bundles `@kohaku-ui/renderer-react` and leaves `requestApproval` unset, so it picks up that package's new default (design.md decision 72): once a widget is awaiting approval for an `"approve"`-tier Action, it asks for the approval token with `globalThis.prompt`. A host iframe without `allow-modals` makes the prompt throw, which is handled as "no token", so the Action simply stays gated as before.

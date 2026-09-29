---
"@kohaku-ui/spec-core": patch
"@kohaku-ui/host-core": patch
"@kohaku-ui/host-rest": patch
"@kohaku-ui/client": patch
"@kohaku-ui/data-binding": patch
"@kohaku-ui/renderer-core": patch
"@kohaku-ui/host-mcp-apps": patch
"@kohaku-ui/mcp-renderer": patch
---

Types only, no wire change: the pending-approval descriptor is now a named `ApprovalRequiredInfo` type exported from spec-core (typing `ErrorEnvelope["error"]["approval"]` and every consumer, with `issues` typed as `ActionParamIssue[]`), and `ActionManifest` / `ActionManifestEntry` are defined once in spec-core and re-exported from host-core, renderer-core and client under their existing names (design.md decisions 62-64).

---
"@kohaku-ui/host-mcp-apps": patch
---

`${prefix}_action` now rejects a `__proto__` key anywhere in `payload` with the structured `ACTION_PARAMS_INVALID` / `unsafeKey` error (design.md decision 62; SPEC ACT-PRM-001). The tool's input schema used to drop that key silently while parsing, so the action gate never saw it and the write ran with the key removed. A non-object or over-deep payload is now a tool error from the handler instead of an SDK input-validation error.

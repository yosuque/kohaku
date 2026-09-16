---
"@kohaku-ui/host-rest": patch
"@kohaku-ui/llm": patch
---

Fix `/lineage` and `/analytics/summary`'s `limit` query parsing, and the LLM retry adapter's `Retry-After` header parsing, to accept only whole decimal-digit strings (rejecting hex, scientific notation, numeric separators, and trailing garbage that a bare `Number`/`parseFloat` would otherwise silently misparse) — closing a TS/Python cross-language divergence on these inputs.

---
"@kohaku-ui/host-mcp-apps": patch
---

The MCP correlation id (`mcp:<session or per-call uuid>:<jsonrpc id>`) is now bounded: a client-controlled JSON-RPC or session id that is over 64 characters or not printable ASCII is replaced by a short sha256 digest, so an oversized id can no longer make a lineage write (indexed `correlationId` column) fail. Compose-family tool results now also carry the id in `_meta["kohaku/requestId"]` (new export `REQUEST_ID_META_KEY`), which is where a caller gets the value to pass to `kohaku explain`.

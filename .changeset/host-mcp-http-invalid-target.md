---
"@kohaku-ui/host": patch
---

`createMcpHttpServer` (`@kohaku-ui/host/mcp-http`) no longer crashes the process on a request-target the URL parser rejects (for example `GET //`, `//[` or `//x:99999`, which parse as protocol-relative references). The URL was parsed outside any error handling whenever `path` or `routes` was set, so the throw became an unhandled rejection. Such a request is now answered with 400 and a JSON-RPC `-32600` `Invalid Request` error.

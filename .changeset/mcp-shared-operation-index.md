---
"@kohaku-ui/host-mcp-apps": patch
---

`attachKohakuToMcpServer` now shares one operation index (and its one-time `paramsSchema` validation) per `DomainPort` instead of building a new one per attach. A stateless HTTP host that re-attaches on every exchange no longer calls `DomainPort.listOperations()` on each request or re-reports the same invalid `paramsSchema` to `onError` every time (design.md decision 62).

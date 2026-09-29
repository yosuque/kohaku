---
"@kohaku-ui/host-rest": patch
---

`SOURCE_MISMATCH` from `GET /binding/resolve` now names the source the host serves (`unknown query source "x" (this host serves "y")`), so a `querySource` / Intent `source` mismatch is diagnosable from the error alone. The Python port's REST profile mirrors the message.

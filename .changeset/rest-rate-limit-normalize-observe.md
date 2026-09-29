---
"@kohaku-ui/host-rest": patch
"@kohaku-ui/host-core": patch
---

`POST /intent/normalize` (which calls the SemanticPort's LLM for a natural-language question) is now rate limited under the `"compose"` route class. A 429 now carries the request's `requestId` in its envelope, and a new optional `KohakuHostDeps.onRateLimited` observer (fire-and-forget, receives host-core's new `RateLimitedInfo`) makes throttling observable.

---
"@kohaku-ui/data-binding": patch
---

`BindingClient` now maps an HTTP 429 (from `resolve` or `invokeAction`) to a new `RATE_LIMITED` `BindingErrorCode` carrying the envelope's `retryAfterMs`, instead of a generic `RESOLVE_FAILED` that lost the backoff hint.

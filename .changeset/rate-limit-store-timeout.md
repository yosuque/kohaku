---
"@kohaku-ui/host-core": patch
---

`createRateLimiter` now races `RateLimitStore.take` against a timeout (default 250 ms, `timeoutMs` option / `PolicyRuntime`'s `rateLimitTimeoutMs`) and fails open with an `onError` notification, so a hung store cannot stall every request; `onError` is no longer awaited (fire-and-forget, as documented).

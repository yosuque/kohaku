---
"@kohaku-ui/host": patch
---

`createKohakuHost` now exposes the REST profile's `approvals` / `rateLimiter` / `actionEffects` / `onRateLimited` as `host.governance`, and `attachKohakuMcp` uses them as defaults (its `deps` override), so one governance configuration applies to both profiles. It also accepts `observer` (composed with the console reporter) and `policyFor`, and logs a console line for rate-limited requests unless `routes.onRateLimited` is given (design.md decision 52).

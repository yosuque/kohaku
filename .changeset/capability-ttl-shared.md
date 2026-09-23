---
"@kohaku-ui/spec-core": patch
"@kohaku-ui/host-core": patch
"@kohaku-ui/authz-hmac": patch
---

`DEFAULT_CAPABILITY_TTL_SECONDS` (600) is now defined once in `@kohaku-ui/spec-core`, next to `AuthzPort`. `@kohaku-ui/host-core` and `@kohaku-ui/authz-hmac` re-export the same binding instead of each keeping an independent copy, so the three packages can no longer drift out of sync. No behavior change.

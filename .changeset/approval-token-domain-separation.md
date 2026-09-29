---
"@kohaku-ui/authz-hmac": patch
---

Approval tokens are now domain-separated from capability tokens cryptographically (design.md decision 63): the approval MAC key is derived from the shared secret under its own label and the MAC input covers the token prefix, and the token prefix is bumped to `kohaku-approval.v2.`. Approval tokens issued by an earlier version (`kohaku-approval.v1.`) are rejected after upgrading; they are short-lived (default TTL 300 s), so an approver only needs to re-issue any approval still pending at the moment of the rollout. Both HMAC ports now type-check every decoded claim and return a denial instead of throwing on a correctly signed but malformed payload.

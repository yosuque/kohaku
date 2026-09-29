---
"@kohaku-ui/host-core": patch
---

`createPolicyRuntime` (and `reload`) now throws a configuration error when the policy file declares `compose.budget.dailyTokens` without a `ledger`, or `rateLimits` without a `rateLimitStore`, instead of silently not enforcing the limit. It also fires `audit` once for the starting file (`previousPolicyId` undefined), keeps its memos on a byte-identical reload, and bounds the per-tenant `policyFor` memo (LRU) while sharing one resolved section across undeclared tenants.

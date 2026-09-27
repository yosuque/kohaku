---
"@kohaku-ui/spec-core": minor
"@kohaku-ui/host-core": minor
"@kohaku-ui/composer": minor
"@kohaku-ui/lineage": minor
"@kohaku-ui/host-rest": minor
"@kohaku-ui/host-mcp-apps": minor
"@kohaku-ui/client": minor
---

Add Policy as Code (design.md #69/#70): a declarative JSON policy file (`KohakuPolicyFileSchema`,
spec-core) layers per-tenant overrides — `allowL2`, `budget.dailyTokens`, `rateLimits`, `governance.roles`
— onto a product-supplied base `ComposePolicy`, without a code change or redeploy. `host-core`'s
`createPolicyRuntime` builds the runtime (`policyFor`, `rateLimiter`, `rolesFor`, `reload`); `loadPolicyFile`
reads and validates one from disk. Every function-shaped `ComposePolicy` field (`routeTier`, `fewShot`,
`designSystem`, `fixedSpecs`, `l2Smoke`, `selectComponents`, `extraRules`) has no schema field at all and
always comes from the base policy.

Add rate limiting: a new `RateLimitStore` port (spec-core) and `createMemoryRateLimitStore`/
`createRateLimiter` (host-core) back the policy file's `rateLimits` section. The REST profile
(`host-rest`) checks it before the compose-family routes and returns `429` with a `RATE_LIMITED` error
envelope and, when reported, an HTTP `Retry-After` header; the client SDK exposes the new
`KohakuHostError.retryAfterMs`. The MCP Apps profile (`host-mcp-apps`) checks it before its 6 tool
handlers and returns a structured tool error (`structuredContent.error.code: "RATE_LIMITED"`, with
`retryAfterMs` when reported) instead. `host-rest` also gains `governancePolicyFromRoles`, a
`GovernanceEvaluator` that re-resolves a `PolicyRuntime`'s roles on every call rather than baking them in
once. `@kohaku-ui/lineage` gains a `policy.applied` audit event (`Lineage.policyApplied`), recorded only
when a policy reload actually changes the effective policy.

**Cache-isolation fix (SPEC CMP-DET-002, new)**: a session's L2 (free-generation) availability
(`allowL2`/`routeTier`) is now folded into the compose cache key's fingerprint (`policyFingerprint`'s new
`tierGate` component), so a cache entry produced under an L2-permissive tenant/policy can no longer be
served to a session where L2 is disallowed. This is additive to `ComposeBudget`, whose `check` hook now
optionally receives a `BudgetCheckContext` (tenant/tier/spentTokens/elapsedMs) and gains an optional
`onUsage` hook, fired once per compose that actually generated.

**Compatibility note**: a policy file (or base `ComposePolicy`) that never sets `allowL2` or `routeTier`
produces a byte-identical fingerprint to before this change — no cache impact. An environment with
`allowL2: true` or a `routeTier` configured (in code or via a policy file) will see exactly one cache miss
per previously-cached intent/tenant/policy combination the first time it composes after upgrading, as the
new `tierGate` fingerprint component takes effect; every subsequent call caches normally.

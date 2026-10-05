---
"@kohaku-ui/host-rest": patch
"@kohaku-ui/host": patch
---

`KohakuHostDeps.dev` (host-rest) folds the two production-facing startup warnings (governance routes open without `authorizeGovernance`, no `auth` so every request is ANONYMOUS) into a single `console.info` line naming whatever is unwired, and prints nothing when both are wired; behavior is unchanged, and without `dev` the two `console.warn` lines are kept verbatim. `createKohakuHost`'s existing `dev` option now forwards to it (`routes.dev` overrides). `@kohaku-ui/host` also re-exports `governancePolicyFromRoles` and `createGovernancePolicy` from host-rest.

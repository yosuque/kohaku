---
"@kohaku-ui/host-rest": patch
"@kohaku-ui/host": patch
---

`KohakuHostDeps.dev` (host-rest) folds the two production-facing startup warnings (governance routes open without `authorizeGovernance`, no `auth` so every request is ANONYMOUS) into a single `console.warn` line (stderr, so a stdio MCP server's stdout stays JSON-RPC only) naming whatever is unwired and the matching consequence, and prints nothing when both are wired; behavior is unchanged, and without `dev` the two `console.warn` lines are kept verbatim. `createKohakuHost`'s existing `dev` option now forwards to it (`routes.dev` overrides; pass `routes: { dev: true }` alone to fold the warnings while keeping the missing-secret throw). `@kohaku-ui/host` also re-exports `governancePolicyFromRoles` and `createGovernancePolicy` from host-rest.

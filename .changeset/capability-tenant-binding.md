---
"@kohaku-ui/spec-core": minor
"@kohaku-ui/authz-hmac": minor
"@kohaku-ui/authz-jwt": minor
"@kohaku-ui/host-core": minor
"@kohaku-ui/host-rest": minor
---

Capability tokens can now carry a signed `tenant` (SPEC CAP-TEN-001, [Draft]), which fixes `KOHAKU_AUTHZ=jwt` on the REST data plane: `/binding/*` used to resolve no tenant, so an `"approve"`-tier Action could never run (its approval token is bound to the approver's tenant), audit records had no tenant, and the rate limit shared one anonymous bucket.

- `spec-core`: `AuthzPort.issueCapability(…, { ttlSeconds?, tenant? })`, `VerifyResult.tenant?` and `InvocationContext.tenant?` (all optional).
- `authz-hmac`: the HMAC payload gains an optional `tenant` claim (an older verifier ignores it) and `createHmacAuthzPort({ requireTenant })` refuses tenant-less tokens, like `requireJti`.
- `authz-jwt`: `createJwtAuthzPort({ requireCapabilityTenant })` passes it through (distinct from the inherited `requireTenant`, which governs the bearer JWT's own claim).
- `host-core`: `issueCapabilityForSpec`, `issueCapabilityForRefs` and `issueSpecCapabilitySafely` take `options.tenant`.
- `host-rest`: compose, events, the stream and the promotion preview bind the resolved tenant. `/binding/resolve` and `/binding/action` treat the capability's tenant as authoritative: it reaches `DomainPort.invoke` as `InvocationContext.tenant`, scopes the approval binding and audit records, and a different `deps.tenant` is `403 CAPABILITY_DENIED`. A capability without a tenant still falls back to `deps.tenant`. Behaviour change: the `/binding/*` rate limit now runs inside the handlers after the capability verified, keyed by `(capability tenant, capability sub, routeClass)`, so requests that fail verification no longer consume or hit the limiter.

---
"@kohaku-ui/spec-core": minor
"@kohaku-ui/authz-hmac": minor
"@kohaku-ui/authz-jwt": minor
"@kohaku-ui/host-core": minor
"@kohaku-ui/host-rest": minor
"@kohaku-ui/host-mcp-apps": minor
---

Capability tokens can now carry a signed `tenant` (SPEC CAP-TEN-001 issuance / CAP-TEN-002 data plane, [Draft]), which fixes `KOHAKU_AUTHZ=jwt` on the REST data plane: `/binding/*` used to resolve no tenant, so an `"approve"`-tier Action could never run (its approval token is bound to the approver's tenant), audit records had no tenant, and the rate limit shared one anonymous bucket.

- `spec-core`: `AuthzPort.issueCapability(…, { ttlSeconds?, tenant? })`, `VerifyResult.tenant?` and `InvocationContext.tenant?` (all optional).
- `authz-hmac`: the HMAC payload gains an optional `tenant` claim (an older verifier ignores it) and `createHmacAuthzPort({ requireTenant })` refuses tenant-less tokens, like `requireJti`.
- `authz-jwt`: `createJwtAuthzPort({ requireCapabilityTenant })` passes it through (distinct from the inherited `requireTenant`, which governs the bearer JWT's own claim).
- `host-core`: `issueCapabilityForSpec`, `issueCapabilityForRefs` and `issueSpecCapabilitySafely` take `options.tenant`.
- `host-rest`: compose, events, the stream and the promotion preview bind the resolved tenant. `/binding/resolve` and `/binding/action` treat the capability's tenant as authoritative: it reaches `DomainPort.invoke` as `InvocationContext.tenant`, scopes the approval binding and audit records, and a different `deps.tenant` is `403 CAPABILITY_DENIED`. A capability without a tenant still falls back to `deps.tenant`. Behaviour change: the `/binding/*` rate limit now runs inside the handlers after the capability verified, keyed by `(capability tenant, capability sub, routeClass)`, so requests that fail verification no longer consume or hit the limiter.

Also in this change:

- `host-mcp-apps`'s `${prefix}_resolve_binding` and `${prefix}_action` carry a tenant a verified capability binds (for example one minted by REST) through to `domain.invoke`, the approval binding and the audit; MCP still resolves and issues no tenant. (`@kohaku-ui/host-mcp-apps`: minor.)
- The tenant claim is at most 256 characters with no control characters; `issueCapability` throws on an invalid one and `verify` treats it, or an explicit `null`, as a malformed payload.
- `/binding/action` checks for the bearer before parsing the body.
- Observability: `/binding/*` 429s and `onRateLimited` (now with `tenant` set) concern verified token holders only; unauthenticated floods show up as 401, 403 or 400, and are bounded only by the body limit, HMAC verification and (with revocation) a store lookup, so put a coarse IP or route limiter in front of the host.
- Rollout: enable `requireTenant` / `requireCapabilityTenant` only after every issuing host is upgraded (older tokens are tenant-less for up to the TTL).
- Python: custom `AuthzPort`s should add `tenant: str | None = None` to `issue_capability` (the value may be ignored). The Protocol now requires it, so the old signature fails mypy; at runtime the REST host degrades to tenant-less issuance for such a port and reports once through `on_error` (`capability.tenant_unsupported`).

---
"@kohaku-ui/authz-hmac": minor
"@kohaku-ui/authz-jwt": minor
"@kohaku-ui/host-core": patch
"@kohaku-ui/host-rest": patch
"@kohaku-ui/host-mcp-apps": patch
---

Hardens capability revocation and JWT identity resolution, and closes a fail-open gap where a revocation-store
outage surfaced as an unhandled raw failure instead of a client-safe, observed one.

`@kohaku-ui/authz-hmac`'s `verify` now evaluates the requested scope before consulting the revocation store
(an out-of-scope request no longer pays for a store round trip), and a store rejection propagates as a thrown
error rather than being silently swallowed — per `AuthzPort.verify`'s doc comment (`@kohaku-ui/spec-core`'s
`ports.ts`): verify throws only on infrastructure failure, and a thrown verify is fail-closed, mapped by the
host to a 5xx. `revokeCapability` now returns `{ ok: true, alreadyExpired: true }` for an already-expired
token (idempotent success, not a failure) and a coded `"STORE_ERROR"` (instead of throwing) when the
revocation store itself fails. Expiry is now `exp <= now` consistently across `verify`, `revokeCapability`,
and the memory store's own sweep (previously `verify`/`revokeCapability` used `exp < now`, off by one second
at the boundary from the memory store). New `HmacAuthzOptions.requireJti` (default `false`) rejects a
capability token with no `jti` claim once a fleet has fully rolled onto a `jti`-issuing version.

`@kohaku-ui/authz-jwt`'s `createJwtIdentityResolver` (and `createJwtAuthzPort`, which constructs one) now
validates its configuration at construction: `audience` is required when `key` is `jwks` or `jwksUrl` (stays
optional for `secret`); an HS256 `key.secret` must be at least 32 bytes; a `jwksUrl` must use `https:` unless
the host is `localhost` / `127.0.0.1` / `::1`. New `requireTenant` option (default `false`) rejects a token
with no (or an empty) tenant claim as `JwtIdentityError({ code: "MISSING_TENANT" })` instead of silently
widening scope to "no tenant" (only applies to the default claim mapping).

`@kohaku-ui/host-core` adds `verifyCapabilitySafely(authz, token, req, onFailure)` (alongside the existing
`issueSpecCapabilitySafely`): calls `authz.verify` and returns a discriminated
`{ kind: "verdict"; verdict } | { kind: "unavailable"; error }` instead of letting a thrown `verify`
propagate, plus the shared `CAPABILITY_VERIFICATION_UNAVAILABLE_MESSAGE` client-safe text constant.
`@kohaku-ui/host-rest`'s `/binding/resolve` and `/binding/action`, and `@kohaku-ui/host-mcp-apps`'s
`kohaku_resolve_binding` / `kohaku_action` tools, now call it and map `"unavailable"` to a client-safe,
observed failure (REST: 503 `INTERNAL` with `"capability verification unavailable"`, reported to `onError`;
MCP: a structured tool error with the same message, reported to `onError`) instead of letting a thrown
`authz.verify` surface as a raw 500 or an unhandled rejection.

---
"@kohaku-ui/spec-core": minor
"@kohaku-ui/authz-hmac": minor
---

Capability tokens can now be revoked before they expire. `@kohaku-ui/spec-core` adds the
`CapabilityRevocationStore` port type (`ports.ts`, alongside `AuthzPort`, which itself is unchanged).
`@kohaku-ui/authz-hmac`'s tokens now carry a `jti`, `createHmacAuthzPort`'s `HmacAuthzOptions` accepts a
`revocations` store, and the returned `HmacAuthzPort` exposes `revokeCapability(token)` (signature
verified first, so a caller cannot revoke a `jti` it merely guessed) alongside the reference
`createMemoryRevocationStore`. A token minted before this change carries no `jti` and verifies as
before; it simply cannot be revoked and is left to expire on its own, so a rolling deploy does not break
an older instance's already-issued tokens.

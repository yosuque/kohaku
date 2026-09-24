# @kohaku-ui/authz-hmac

HMAC-SHA256 capability tokens for kohaku's `AuthzPort`.

- `createHmacAuthzPort(secret, options?)` — an on-behalf-of token whose payload is transparent (`base64url(payload).base64url(hmac)`), suitable as the default issuer for a single host. `options.ttlSeconds` sets the default capability lifetime (600s by default) when `issueCapability`'s own `opts.ttlSeconds` is omitted.

This is a reference implementation: the contract is `AuthzPort` in `@kohaku-ui/spec-core`; production principal resolution (JWT / OIDC) is `@kohaku-ui/authz-jwt`, which signs capabilities the same way behind a JWT/OIDC principal resolver.

## Capability revocation

Every token `issueCapability` mints now carries a `jti`, and `verify` consults an injectable `revocations` store (a `CapabilityRevocationStore`, defined in `@kohaku-ui/spec-core`) on every call. The returned port exposes `revokeCapability`:

```ts
import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { createRedisRevocationStore } from "@kohaku-ui/storage-redis";

const authz = createHmacAuthzPort(secret, {
  revocations: createRedisRevocationStore({ url: process.env.KOHAKU_REDIS_URL! }),
});

const token = await authz.issueCapability(principal, scopes);
await authz.revokeCapability(token); // { ok: true }
await authz.verify(token, req); //     { ok: false, reason: "capability revoked" }
```

`revokeCapability` takes the whole token, not a bare `jti`: it verifies the signature first, so a caller can never revoke an identifier it merely guessed. It fails closed with a `reason` instead of throwing — `"malformed token"` / `"invalid signature"` / `"malformed payload"` for a tampered or foreign token, `"capability expired"` for one already past its `exp` (revoking it would just grow the store for nothing), and `"token predates revocation support"` for one minted before this feature existed (see below).

**Pre-upgrade tokens**: a token issued before `revokeCapability` existed carries no `jti`. It still verifies exactly as before and simply runs to its `exp` — it cannot be made revocable retroactively. This is deliberate (a rolling deploy should not invalidate an older instance's already-issued tokens), but it is silent: nothing logs a jti-less token being accepted, so the only way to know a fleet is safe to rely on revocation for is to know it has fully rolled onto a `jti`-issuing version.

**Store**: `options.revocations` defaults to `createMemoryRevocationStore()`, an in-process `Map<jti, expiresAt>` — fine for a single instance or for tests, but not durable: **a process restart drops every revocation it was holding, so a token revoked just before the restart quietly becomes valid again until its own `exp`.** A multi-instance or restart-safe deployment should inject a shared store instead: `@kohaku-ui/storage-redis`'s `createRedisRevocationStore` or `@kohaku-ui/storage-postgres`'s `createPostgresRevocationStore`. `CapabilityRevocationStore` itself is defined in `@kohaku-ui/spec-core` rather than here, purely for dependency-direction layering (`spec/test/dependency-direction.test.ts` forbids a same-layer dependency, and the two storage packages need the type while sharing a layer with this one).

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md).

The packages in this scope share a single version and are designed to be installed together.

- Documentation: https://github.com/yosuque/kohaku#readme
- Source: https://github.com/yosuque/kohaku/tree/main/packages/authz-hmac

Licensed under the Apache License, Version 2.0.

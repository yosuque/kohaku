# @kohaku-ui/authz-hmac

HMAC-SHA256 capability tokens for kohaku's `AuthzPort`.

- `createHmacAuthzPort(secret, options?)` — an on-behalf-of token whose payload is transparent (`base64url(payload).base64url(hmac)`), suitable as the default issuer for a single host. `options.ttlSeconds` sets the default capability lifetime (600s by default) when `issueCapability`'s own `opts.ttlSeconds` is omitted.

This is a reference implementation: the contract is `AuthzPort` in `@kohaku-ui/spec-core`; production principal resolution (JWT / OIDC) is `@kohaku-ui/authz-jwt`, which signs capabilities the same way behind a JWT/OIDC principal resolver.

## Capability revocation

Every token `issueCapability` mints now carries a `jti`, and `verify` consults an injectable `revocations` store (a `CapabilityRevocationStore`, defined in `@kohaku-ui/spec-core`) on every call, but only *after* the requested scope is granted — an out-of-scope request never pays for a store round trip, and a store outage only affects requests that would otherwise have succeeded. The returned port exposes `revokeCapability`:

```ts
import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { createRedisRevocationStore } from "@kohaku-ui/storage-redis";
// storage-redis's ioredis peer dependency must be installed alongside it.

const authz = createHmacAuthzPort(secret, {
  revocations: createRedisRevocationStore({ url: process.env.KOHAKU_REDIS_URL! }),
});

const token = await authz.issueCapability(principal, scopes);
await authz.revokeCapability(token); // { ok: true }
await authz.verify(token, req); //     { ok: false, reason: "capability revoked" }
```

`revokeCapability` returns a coded `RevokeCapabilityResult` (`@kohaku-ui/spec-core`) instead of throwing — it fails closed with a `code` and a human-readable `reason`: `"MALFORMED"` / `"INVALID_SIGNATURE"` for a tampered, foreign, or unparseable token, `"NO_JTI"` for one minted before this feature existed (see below), and `"STORE_ERROR"` when the revocation store itself throws (the store failure is caught here and reported as a coded result, unlike `verify` — see "Revocation-store failures" below). Revoking a token already past its `exp` is `{ ok: true, alreadyExpired: true }`, an idempotent success rather than a failure: the token can no longer verify regardless, so writing a revocation record for it would just grow the store for nothing. "Expired" uses the same `exp <= now` boundary everywhere (`verify`, `revokeCapability`, and the memory store's own sweep).

**`requireJti`**: `options.requireJti` (default `false`) makes `verify` reject a jti-less token outright (reason `"capability lacks jti"`) instead of the default backward-compatible acceptance. Roll this out only after a fleet has fully switched to a `jti`-issuing version and no pre-upgrade token can still be in circulation (past its TTL from the rollout instant) — turning it on earlier would fail `verify` for a still-valid pre-upgrade token.

**Revocation-store failures**: `verify`'s revocation check is *not* caught — a store rejection (timeout, connection failure, etc.) propagates as a thrown error, which is fail-closed by contract (see `AuthzPort.verify`'s doc comment in `@kohaku-ui/spec-core`'s `ports.ts`): a caller MUST treat a thrown `verify` as a denial, and a host serving requests over this port MUST map it to a 5xx response. `revokeCapability`, by contrast, has no non-throwing "deny" outcome to fall back on for an infra failure, so it catches a store throw itself and returns the coded `"STORE_ERROR"` result described above instead.

**Pre-upgrade tokens**: a token issued before `revokeCapability` existed carries no `jti`. It still verifies exactly as before and simply runs to its `exp` — it cannot be made revocable retroactively. This is deliberate (a rolling deploy should not invalidate an older instance's already-issued tokens), but it is silent: nothing logs a jti-less token being accepted, so the only way to know a fleet is safe to rely on revocation for is to know it has fully rolled onto a `jti`-issuing version.

**Store**: `options.revocations` defaults to `createMemoryRevocationStore()`, an in-process `Map<jti, expiresAt>` — fine for a single instance or for tests, but not durable: **a process restart drops every revocation it was holding, so a token revoked just before the restart quietly becomes valid again until its own `exp`.** A multi-instance or restart-safe deployment should inject a shared store instead: `@kohaku-ui/storage-redis`'s `createRedisRevocationStore` or `@kohaku-ui/storage-postgres`'s `createPostgresRevocationStore`. `CapabilityRevocationStore` itself is defined in `@kohaku-ui/spec-core` rather than here, purely for dependency-direction layering (`spec/test/dependency-direction.test.ts` forbids a same-layer dependency, and the two storage packages need the type while sharing a layer with this one).

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md).

The packages in this scope share a single version and are designed to be installed together.

- Documentation: https://github.com/yosuque/kohaku#readme
- Source: https://github.com/yosuque/kohaku/tree/main/packages/authz-hmac

Licensed under the Apache License, Version 2.0.

# @kohaku-ui/authz-jwt

JWT / OIDC identity resolution for kohaku hosts — verifies a bearer JWT with [`jose`](https://github.com/panva/jose) and maps its claims to kohaku's `Principal` plus a tenant, while delegating capability tokens unchanged to [`@kohaku-ui/authz-hmac`](https://github.com/yosuque/kohaku/tree/main/packages/authz-hmac). The contract stays `@kohaku-ui/spec-core`'s `ports.ts`.

```ts
import { createJwtAuthzPort } from "@kohaku-ui/authz-jwt";

const authz = createJwtAuthzPort({
  key: { jwksUrl: "https://issuer.example.com/.well-known/jwks.json" },
  issuer: "https://issuer.example.com",
  audience: "kohaku",
  capabilitySecret: process.env.KOHAKU_CAPABILITY_SECRET!,
});

// Resolve the caller from the request's Authorization header (a host's principal/tenant hooks):
const { principal, tenant } = await authz.identity.fromAuthorizationHeader(req.headers.authorization);

// Capability issuance/verification is the unchanged @kohaku-ui/authz-hmac scheme:
const token = await authz.issueCapability(principal, [{ kind: "read", ref: "query://sales/summary" }]);
await authz.verify(token, { kind: "read", ref: "query://sales/summary" });
```

## Identity resolution

`createJwtIdentityResolver` verifies signature, `exp`/`nbf`, and optionally `iss`, then maps claims to a `Principal` (`id`, optional `name`, optional `roles`) and an optional `tenant`. The default claim names are `sub` / `name` / `roles` / `tenant`; override them with `claims` for issuers that namespace custom claims (Auth0-style URLs), or bypass the mapping entirely with `mapClaims`. The `roles` claim accepts either a `string[]` or a whitespace-separated `string` (OIDC `scope`-style).

The key source (`{ secret }`, `{ jwks }`, or `{ jwksUrl }`) also fixes the default algorithm allow-list — `["HS256"]` for a shared secret, `["RS256", "ES256", "EdDSA"]` for a JWK set — which a caller can narrow or replace with `algorithms`. This allow-list is a security boundary: a JWKS-configured resolver rejects an HS256-signed token even if it happens to verify against some key in the set.

**Construction-time validation** (throws synchronously, before any token is ever verified):
- **`audience` is required** when `key` is `jwks` or `jwksUrl` — a JWKS-configured resolver typically talks to a third-party issuer that mints tokens for other audiences too, so skipping the `aud` check would accept a token never meant for this service. `audience` stays optional in `secret` mode.
- **`key.secret` must be at least 32 bytes** (UTF-8) — a shorter HS256 shared secret is brute-forceable well before the hash itself becomes the weak link.
- **`jwksUrl` must use `https:`**, unless the host is `localhost` / `127.0.0.1` / `::1` (local development or tests only) — fetching a JWKS over plain HTTP to a real issuer would let a network attacker substitute their own keys and forge tokens this resolver would then accept.

**`requireTenant`** (default `false`): when true, a token with no (or an empty) tenant claim rejects with `JwtIdentityError({ code: "MISSING_TENANT" })` instead of resolving with `{ principal }` (no tenant). Only applies to the default claim mapping — a caller supplying `mapClaims` is responsible for its own tenant requirement, if any.

Failures throw `JwtIdentityError` with a `code` (`MISSING_TOKEN` / `INVALID_TOKEN` / `MISSING_SUBJECT` / `MISSING_TENANT`) and, for `INVALID_TOKEN`, the underlying `jose` error as `cause`, so a host can log the real reason while returning an opaque message to the caller.

## Capability tokens are unchanged, including revocation

`createJwtAuthzPort` delegates `issueCapability` / `verify` to `@kohaku-ui/authz-hmac` untouched — a JWT is never a capability and a capability is never a JWT. This means capability revocation is also the unchanged `@kohaku-ui/authz-hmac` scheme: pass `revocations` (a `CapabilityRevocationStore`, e.g. from `@kohaku-ui/storage-redis` or `@kohaku-ui/storage-postgres`) and the returned port's `revokeCapability(token)` delegates straight through.

```ts
import { createRedisRevocationStore } from "@kohaku-ui/storage-redis";
// storage-redis's ioredis peer dependency must be installed alongside it.

const authz = createJwtAuthzPort({
  key: { jwksUrl: "https://issuer.example.com/.well-known/jwks.json" },
  audience: "kohaku",
  capabilitySecret: process.env.KOHAKU_CAPABILITY_SECRET!,
  revocations: createRedisRevocationStore({ url: process.env.KOHAKU_REDIS_URL! }),
});

await authz.revokeCapability(token); // signature verified first; a tampered or foreign token is rejected
```

**A token minted before this change carries no `jti` and therefore still cannot be revoked**: it verifies exactly as before and is left to expire on its own. This is the one thing worth watching operationally, because it is silent — nothing logs a jti-less token being accepted, so the only signal an operator has is knowing when a fleet finished rolling onto a `jti`-issuing version.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md).

The packages in this scope share a single version and are designed to be installed together.

- Documentation: https://github.com/yosuque/kohaku#readme
- Source: https://github.com/yosuque/kohaku/tree/main/packages/authz-jwt

Licensed under the Apache License, Version 2.0.

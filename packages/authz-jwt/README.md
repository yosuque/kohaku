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

`createJwtIdentityResolver` verifies signature, `exp`/`nbf`, and optionally `iss`/`aud`, then maps claims to a `Principal` (`id`, optional `name`, optional `roles`) and an optional `tenant`. The default claim names are `sub` / `name` / `roles` / `tenant`; override them with `claims` for issuers that namespace custom claims (Auth0-style URLs), or bypass the mapping entirely with `mapClaims`. The `roles` claim accepts either a `string[]` or a whitespace-separated `string` (OIDC `scope`-style).

The key source (`{ secret }`, `{ jwks }`, or `{ jwksUrl }`) also fixes the default algorithm allow-list — `["HS256"]` for a shared secret, `["RS256", "ES256", "EdDSA"]` for a JWK set — which a caller can narrow or replace with `algorithms`. This allow-list is a security boundary: a JWKS-configured resolver rejects an HS256-signed token even if it happens to verify against some key in the set.

Failures throw `JwtIdentityError` with a `code` (`MISSING_TOKEN` / `INVALID_TOKEN` / `MISSING_SUBJECT`) and the underlying `jose` error as `cause`, so a host can log the real reason while returning an opaque message to the caller.

## Capability tokens are unchanged, and cannot be revoked

`createJwtAuthzPort` delegates `issueCapability` / `verify` to `@kohaku-ui/authz-hmac` untouched — a JWT is never a capability and a capability is never a JWT. This means an issued capability cannot be revoked before its `exp`: a deployment that needs revocation should issue short TTLs and re-issue rather than relying on withdrawal. This is a property of the reference implementation (`@kohaku-ui/authz-hmac` has no deny list or key rotation), not of the `AuthzPort` contract itself.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md).

The packages in this scope share a single version and are designed to be installed together.

- Documentation: https://github.com/yosuque/kohaku#readme
- Source: https://github.com/yosuque/kohaku/tree/main/packages/authz-jwt

Licensed under the Apache License, Version 2.0.

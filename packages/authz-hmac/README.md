# @kohaku-ui/authz-hmac

HMAC-SHA256 capability tokens for kohaku's `AuthzPort`.

- `createHmacAuthzPort(secret, options?)` — an on-behalf-of token whose payload is transparent (`base64url(payload).base64url(hmac)`), suitable as the default issuer for a single host. `options.ttlSeconds` sets the default capability lifetime (600s by default) when `issueCapability`'s own `opts.ttlSeconds` is omitted.

This is a reference implementation: the contract is `AuthzPort` in `@kohaku-ui/spec-core`; production principal resolution (JWT / OIDC) is `@kohaku-ui/authz-jwt`, which signs capabilities the same way behind a JWT/OIDC principal resolver.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md).

The packages in this scope share a single version and are designed to be installed together.

- Documentation: https://github.com/yosuque/kohaku#readme
- Source: https://github.com/yosuque/kohaku/tree/main/packages/authz-hmac

Licensed under the Apache License, Version 2.0.

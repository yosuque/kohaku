# @kohaku-ui/host-mcp-apps

## 0.3.0

### Patch Changes

- [#32](https://github.com/yosuque/kohaku/pull/32) [`244136c`](https://github.com/yosuque/kohaku/commit/244136c70cb1875c084589c7640ee3fbb3880f4c) Thanks [@yosuque](https://github.com/yosuque)! - Hardens capability revocation and JWT identity resolution, and closes a fail-open gap where a revocation-store
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
- Updated dependencies [[`244136c`](https://github.com/yosuque/kohaku/commit/244136c70cb1875c084589c7640ee3fbb3880f4c), [`a26f9be`](https://github.com/yosuque/kohaku/commit/a26f9be35f5702287e79f67f13bd3298bfb73bc5), [`ad51284`](https://github.com/yosuque/kohaku/commit/ad5128464169d389e0c462c59184d411ba359d8e), [`cffc1aa`](https://github.com/yosuque/kohaku/commit/cffc1aac259bfdc8f22c48ae57427a809853924e)]:
  - @kohaku-ui/host-core@0.3.0
  - @kohaku-ui/spec-core@0.3.0
  - @kohaku-ui/composer@0.3.0
  - @kohaku-ui/data-binding@0.3.0

## 0.2.0

### Patch Changes

- [#18](https://github.com/yosuque/kohaku/pull/18) [`6832862`](https://github.com/yosuque/kohaku/commit/68328625443a848307e3fb70aff7b1c757c08bea) Thanks [@yosuque](https://github.com/yosuque)! - Declare `@modelcontextprotocol/server` as a peer dependency instead of a regular dependency. `attachKohakuToMcpServer` attaches to the `McpServer` the application constructs, so the application and kohaku must share one copy of the SDK (the same rule this workspace already applies to `zod`). Add `@modelcontextprotocol/server` to your own dependencies if it is not there yet.

- [#9](https://github.com/yosuque/kohaku/pull/9) [`4feec33`](https://github.com/yosuque/kohaku/commit/4feec33c200ae6174129e9ce0846c1550ed8bc0f) Thanks [@yosuque](https://github.com/yosuque)! - Add `McpHostDeps.resolvePrincipal` (TS) / `resolve_principal` (Python) to resolve the caller's identity per tool call instead of once per attached server, fail-closed on a throw, so a shared Streamable HTTP deployment no longer has to run every connection under one static `principal`.

- [#10](https://github.com/yosuque/kohaku/pull/10) [`824b1d4`](https://github.com/yosuque/kohaku/commit/824b1d467b0af846b5f6cbfa78a1a9af81babdfa) Thanks [@yosuque](https://github.com/yosuque)! - Move the Python MCP host (`kohaku-ui[mcp]`) onto the `mcp` 2.x SDK, raising its floor to `>=2.2`. `attach_kohaku_to_mcp_server`'s public signature is unchanged, but `McpHostDeps.resolve_principal` now takes `ctx: ServerRequestContext` directly (no longer `| None`) — a product-supplied resolver reading `ctx.meta` should switch from attribute access (`getattr(ctx.meta, "key", None)`) to dict access (`ctx.meta.get("key")`), since `meta` is now a `RequestParamsMeta` TypedDict rather than an object. `resources/read` also gains `ttl_ms`/`cache_scope` cache hints, closing a gap the Python host previously had relative to TS.
- Updated dependencies [[`642330d`](https://github.com/yosuque/kohaku/commit/642330d89c85b47716a28b0a7fde36097e7e50ef), [`ffff046`](https://github.com/yosuque/kohaku/commit/ffff046628f1779bbc9b1a1a4c9d4256f82a9cd3), [`cf2623c`](https://github.com/yosuque/kohaku/commit/cf2623cd2688969db1156d0817ffff08bbe3f610), [`8f6fe5a`](https://github.com/yosuque/kohaku/commit/8f6fe5aaee025c83c8494f5dc4bd97a2a7513b11), [`cec01e1`](https://github.com/yosuque/kohaku/commit/cec01e166d2947fe8b4bbbfbe5c306c33aaccf99), [`1c2a1da`](https://github.com/yosuque/kohaku/commit/1c2a1da8760ce3af8a49d90d803f6a574c851bbe), [`a318995`](https://github.com/yosuque/kohaku/commit/a318995245309f7b492b52a44fbae1a8c891a353)]:
  - @kohaku-ui/composer@0.2.0
  - @kohaku-ui/spec-core@0.2.0
  - @kohaku-ui/host-core@0.2.0
  - @kohaku-ui/data-binding@0.2.0

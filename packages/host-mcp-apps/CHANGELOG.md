# @kohaku-ui/host-mcp-apps

## 0.2.0

### Minor Changes

- [#9](https://github.com/yosuque/kohaku/pull/9) [`4feec33`](https://github.com/yosuque/kohaku/commit/4feec33c200ae6174129e9ce0846c1550ed8bc0f) Thanks [@yosuque](https://github.com/yosuque)! - Add `McpHostDeps.resolvePrincipal` (TS) / `resolve_principal` (Python) to resolve the caller's identity per tool call instead of once per attached server, fail-closed on a throw, so a shared Streamable HTTP deployment no longer has to run every connection under one static `principal`.

- [#10](https://github.com/yosuque/kohaku/pull/10) [`824b1d4`](https://github.com/yosuque/kohaku/commit/824b1d467b0af846b5f6cbfa78a1a9af81babdfa) Thanks [@yosuque](https://github.com/yosuque)! - Move the Python MCP host (`kohaku-ui[mcp]`) onto the `mcp` 2.x SDK, raising its floor to `>=2.2`. `attach_kohaku_to_mcp_server`'s public signature is unchanged, but `McpHostDeps.resolve_principal` now takes `ctx: ServerRequestContext` directly (no longer `| None`) — a product-supplied resolver reading `ctx.meta` should switch from attribute access (`getattr(ctx.meta, "key", None)`) to dict access (`ctx.meta.get("key")`), since `meta` is now a `RequestParamsMeta` TypedDict rather than an object. `resources/read` also gains `ttl_ms`/`cache_scope` cache hints, closing a gap the Python host previously had relative to TS.

### Patch Changes

- Updated dependencies [[`1c2a1da`](https://github.com/yosuque/kohaku/commit/1c2a1da8760ce3af8a49d90d803f6a574c851bbe)]:
  - @kohaku-ui/composer@0.2.0
  - @kohaku-ui/data-binding@0.2.0
  - @kohaku-ui/host-core@0.2.0
  - @kohaku-ui/spec-core@0.2.0

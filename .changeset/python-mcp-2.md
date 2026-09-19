---
"@kohaku-ui/host-mcp-apps": patch
---

Move the Python MCP host (`kohaku-ui[mcp]`) onto the `mcp` 2.x SDK, raising its floor to `>=2.2`. `attach_kohaku_to_mcp_server`'s public signature is unchanged, but `McpHostDeps.resolve_principal` now takes `ctx: ServerRequestContext` directly (no longer `| None`) — a product-supplied resolver reading `ctx.meta` should switch from attribute access (`getattr(ctx.meta, "key", None)`) to dict access (`ctx.meta.get("key")`), since `meta` is now a `RequestParamsMeta` TypedDict rather than an object. `resources/read` also gains `ttl_ms`/`cache_scope` cache hints, closing a gap the Python host previously had relative to TS.

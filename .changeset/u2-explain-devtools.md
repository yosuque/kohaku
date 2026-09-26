---
"@kohaku-ui/composer": minor
"@kohaku-ui/lineage": minor
"@kohaku-ui/host-core": minor
"@kohaku-ui/host-mcp-apps": minor
"@kohaku-ui/client": minor
"@kohaku-ui/cli": minor
"@kohaku-ui/admin-react": minor
---

Add `kohaku explain <requestId>` and Kohaku DevTools (`@kohaku-ui/admin-react/devtools`), answering "why
did this view come out this way" from a request id alone: tier, cache hit/miss, the cache key's individual
components, the L1/L2 decision flow (attempts, capability-negotiation downgrades, single-flight
coalescing, token usage), capability scopes, and the related lineage events.

- `ComposeTrace.cacheKeyParts` records the exact `CacheKeyParts` a compose's `cacheKey` was built from
  (the opaque, colon-joined `cacheKey` string cannot be split back apart after the fact).
- `view.composed` / `component.generated` / `component.used` / `view.fallback` lineage payloads gain
  `correlationId`, `cacheKey`, `cacheKeyParts`, `generatorVersion`, `kit`, `fallback`, and a `decision`
  summary — all optional and omitted when unset, so every pre-existing event keeps its exact shape.
- `host-mcp-apps`' MCP compose correlation id is now `mcp:<sessionId>:<jsonrpc id>` (or `mcp:<jsonrpc id>`
  for a session-less transport such as stdio), replacing the bare JSON-RPC request id.
- `@kohaku-ui/client` reads a compose response's `X-Request-Id` header (`ComposeView.requestId`, the
  stream's `done` event), adds `KohakuClientConfig.onResponse`, and exposes `client.explain(requestId)` /
  the pure `buildExplainReport(events, spec?)`.
- `kohaku explain <requestId> --rest <baseUrl>` renders the explain report as text or JSON (`--json`),
  optionally with capability scopes (`--spec <file>`).
- `@kohaku-ui/admin-react/devtools`'s `KohakuDevTools` component (+ `withDevToolsCapture` for a
  "recent requests" quick-pick) renders the same report across six panels, on its own subpath decoupled
  from `AdminProvider`/`KohakuAdmin` (same dependency boundary as the package root: client / renderer-core
  / sandbox / spec-core only, never `renderer-react`).

See docs/user-guide.md's "Kohaku DevTools and `kohaku explain`" section, including the
`Access-Control-Expose-Headers: X-Request-Id` CORS requirement for a browser-hosted client.

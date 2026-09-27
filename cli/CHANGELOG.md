# @kohaku-ui/cli

## 0.4.0

### Minor Changes

- [#50](https://github.com/yosuque/kohaku/pull/50) [`78dfcb0`](https://github.com/yosuque/kohaku/commit/78dfcb07302775295286349cab313e48d892e39b) Thanks [@yosuque](https://github.com/yosuque)! - Add `@kohaku-ui/host`, a new package: `createKohakuHost()` wires the default Port implementations
  (`createMemoryStoragePort`, `createHmacAuthzPort`, `createLlmSemanticPort` built from an `intents` catalog,
  `resolveCatalog(coreCatalog)`) into `@kohaku-ui/host-rest`'s `createKohakuRoutes` in one call, with every
  default independently overridable via `storage` / `authz` / `semantic` / `catalog`. `llm` is always required
  (never defaulted from a fake or the environment). `host-core`'s `createConsoleErrorReporter` is wired into
  both the REST profile's `onError` and the compose observer's `onError` by default. The capability secret for
  the default `authz` is resolved from `capabilitySecret` or the `KOHAKU_CAPABILITY_SECRET` environment
  variable; `dev: true` generates a temporary one (with a `console.warn`) instead of throwing, for local
  development only.
  
  MCP is a separate `@kohaku-ui/host/mcp` subpath (`attachKohakuMcp(server, host, options)`, calling
  `@kohaku-ui/host-mcp-apps`'s `attachKohakuToMcpServer` with the `compose` / Ports the facade already built) —
  `@kohaku-ui/host`'s main entry point never imports it, so a REST-only consumer never needs
  `@kohaku-ui/host-mcp-apps` or `@modelcontextprotocol/server` (both are optional peer dependencies of this
  package, not ordinary ones — install both yourself to use `./mcp`).
  
  `kohaku init`'s generated `server/app.ts` and `kohaku scaffold ports`'s scaffold are both rewired onto
  `createKohakuHost`: the generated project's direct `@kohaku-ui/*` dependencies drop from 15 to 10 (host-rest
  / host-core / semantic-llm / storage-memory / authz-hmac / registry are no longer imported directly), and
  `scaffold ports` now generates only a `DomainPort` (`ports.ts`) plus an Intent catalog (`intents.ts`, new
  file) instead of hand-writing all four Ports — 2 TODOs instead of 5.
  
  See `docs/design.md` decision [#52](https://github.com/yosuque/kohaku/issues/52) for the full rationale, including why MCP is a separate subpath.
  
  **Before its first release, a maintainer must bootstrap the new package** (`node scripts/npm-bootstrap.mjs
  --publish`, run from a maintainer's own terminal) — see `docs/runbooks/release.md`, "First publish of a new
  package": npm can only register a trusted publisher for a package that already exists on the registry, so
  `@kohaku-ui/host`'s own first publish cannot go through `release.yml`'s OIDC flow the way every other
  package's release already does.

- [#51](https://github.com/yosuque/kohaku/pull/51) [`e9f7d34`](https://github.com/yosuque/kohaku/commit/e9f7d34b62c169b2e56af970f68ade6d2ff1b31c) Thanks [@yosuque](https://github.com/yosuque)! - Add `kohaku explain <requestId>` and Kohaku DevTools (`@kohaku-ui/admin-react/devtools`), answering "why
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

### Patch Changes

- [#45](https://github.com/yosuque/kohaku/pull/45) [`3d523bf`](https://github.com/yosuque/kohaku/commit/3d523bf339ff7d114feea684dfcbc9c161a5f039) Thanks [@yosuque](https://github.com/yosuque)! - Makes a fallback's reason and an `onError` observation honest about *why* generation degraded, instead of
  collapsing every non-happy-path into the same wording.
  
  `composer`'s L1 tier ladder previously returned the identical "L1 constrained generation failed
  catalog/structure validation" reason whether the LLM provider was actually unreachable (a transient
  error) or the model answered but its output failed validation. A transient failure now gets its own
  reason naming the provider (with the underlying `LlmError` code in parentheses when known, e.g. "(provider
  error)") and pointing at `KOHAKU_LLM_PROVIDER`/the provider API key; the validation-failure wording is
  unchanged. New `ComposeErrorContext.failure` and `TierResult.lastError` let `observer.onError` receive the
  classified failure kind and the underlying error (previously always `undefined` for a fallback) without
  string-matching `reason`.
  
  `refs.ts`'s `SEMANTIC_FAILED` wrapping now appends a `resolveQuery` failure's own message when the cause
  explicitly opts in with a readonly `clientSafe: true` property, so e.g. an unknown Intent name reaches the
  caller instead of the generic "query resolution failed" alone. This is deliberately narrower than "any
  error with a string `code`" (host-core's existing `isTypedHostError` convention): a `SemanticPort` commonly
  delegates to a database/filesystem/HTTP client whose own errors also carry a string `code` (e.g.
  `ECONNREFUSED`) while their `message` can contain hostnames, paths, or table names, so `code` alone is not
  safe to trust here — every cause without `clientSafe: true` is left exactly as before. `semantic-llm`'s
  `resolveQuery` now throws a typed `UnknownIntentError` (exported, `clientSafe: true`) instead of a plain
  `Error`, so its own unknown-intent failures benefit from this.
  
  New `host-core` `formatErrorChain` (walks `Error.cause`, depth-capped against cycles) and
  `createConsoleErrorReporter` (a pair of handlers pre-wired to `KohakuHostDeps.onError` and
  `ComposeObserver.onError`'s exact signatures) give a generated project sensible default logging.
  `kohaku init` wires both hooks in the generated `app.ts`, gated by a new `KOHAKU_DEBUG` env var
  (documented in `.env.example`): unset/any other value keeps today's one-line summaries, `KOHAKU_DEBUG=1`
  prints the full cause chain and stack trace instead.
- Updated dependencies [[`eb67e28`](https://github.com/yosuque/kohaku/commit/eb67e28455ab36683e61eaa03d4b9edf8def8a5d), [`3d523bf`](https://github.com/yosuque/kohaku/commit/3d523bf339ff7d114feea684dfcbc9c161a5f039), [`5a07b1a`](https://github.com/yosuque/kohaku/commit/5a07b1adbcb1545bbc35df0c6df9ed54a22fcf29), [`8df82f6`](https://github.com/yosuque/kohaku/commit/8df82f661b601ac986049302d888ee058bcde27d), [`36392f0`](https://github.com/yosuque/kohaku/commit/36392f05d3e4fa8426e6e6ab24c50081cc057595), [`e9f7d34`](https://github.com/yosuque/kohaku/commit/e9f7d34b62c169b2e56af970f68ade6d2ff1b31c)]:
  - @kohaku-ui/evals@0.4.0
  - @kohaku-ui/composer@0.4.0
  - @kohaku-ui/spec-core@0.4.0
  - @kohaku-ui/client@0.4.0
  - @kohaku-ui/spec@0.4.0
  - @kohaku-ui/sandbox@0.4.0

## 0.3.0

### Minor Changes

- [#32](https://github.com/yosuque/kohaku/pull/32) [`b19b7c1`](https://github.com/yosuque/kohaku/commit/b19b7c156304c2e63ce9d1851d5bd0479442fd62) Thanks [@yosuque](https://github.com/yosuque)! - `kohaku init`'s generated project no longer falls back to a fixed `dev-secret-change-me` capability secret:
  `server/app.ts` now throws `KOHAKU_CAPABILITY_SECRET is required (see .env.example)` when it is unset, and
  `initProject` writes a real, randomly generated secret (`randomBytes(32).toString("base64url")`) to a
  git-ignored `.env` so the generated project still runs out of the box; `.env.example` now ships that var
  empty (with a comment) instead of a shared placeholder value, and the generated `server/app.ts` loads `.env`
  itself so this also works when it's imported directly (the golden test, scripting) rather than only via
  `server/main.ts`.
  
  `@kohaku-ui/llm`'s `resolveLlmEnv` now treats an empty-string (or whitespace-only) `KOHAKU_LLM_API_KEY` or
  provider-standard key env var as unset instead of a configured empty key — needed because the generated
  `.env.example`'s `KOHAKU_LLM_API_KEY=` placeholder previously defeated the fallback to `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` once loaded via `process.loadEnvFile`.
  
  Also: the CLI's own description and `--help` text now mention `init` / project generation; `kohaku init`'s
  "Next steps" output and the generated README point at the one-time `KOHAKU_GOLDEN_UPDATE=1 npm test`; the
  generated README notes that Chat only answers within the generated Intent catalog (`NO_MATCH` otherwise,
  widened via `fallbackIntent`); and the root README / user guide point at
  `cli/test/init/fixtures/sales.csv` for anyone without a CSV of their own to try.

- [#27](https://github.com/yosuque/kohaku/pull/27) [`a853a99`](https://github.com/yosuque/kohaku/commit/a853a99131d723211b511c33c5cb7bd75f8fe16c) Thanks [@yosuque](https://github.com/yosuque)! - Zero-Port quickstart: `kohaku init --from <data.csv|.json|.sqlite>` generates a runnable app (DomainPort, Intent catalog, L0 fixed Spec, Dashboard + Chat, golden test) that depends only on the published packages. New package `@kohaku-ui/semantic-llm` provides the default SemanticPort (`createLlmSemanticPort`) and a generic Intent catalog; the sample API now builds on it.

### Patch Changes

- [#33](https://github.com/yosuque/kohaku/pull/33) [`79d4307`](https://github.com/yosuque/kohaku/commit/79d430747add16102065f9ff9f0f7c1071750094) Thanks [@yosuque](https://github.com/yosuque)! - Dependency updates: the Vercel AI SDK (`ai` ^7.0.108, `@ai-sdk/anthropic` ^4.0.58, `@ai-sdk/openai` ^4.0.72, `@ai-sdk/google` ^4.0.76, `@ai-sdk/openai-compatible` ^3.0.53). Projects generated by `kohaku init` now pin `@ai-sdk/anthropic` ^4.0.58, `@ai-sdk/openai-compatible` ^3.0.53, `@types/node` ^26.6.2 and `tsx` ^4.23.15.
- Updated dependencies [[`a26f9be`](https://github.com/yosuque/kohaku/commit/a26f9be35f5702287e79f67f13bd3298bfb73bc5), [`ad51284`](https://github.com/yosuque/kohaku/commit/ad5128464169d389e0c462c59184d411ba359d8e), [`cffc1aa`](https://github.com/yosuque/kohaku/commit/cffc1aac259bfdc8f22c48ae57427a809853924e), [`9e227c9`](https://github.com/yosuque/kohaku/commit/9e227c9dd2ceda6b9c2483296be4b4dc0e090bfd), [`cd12831`](https://github.com/yosuque/kohaku/commit/cd12831667055a0d7aec31453dcc6a7e3448e47c)]:
  - @kohaku-ui/spec-core@0.3.0
  - @kohaku-ui/evals@0.3.0
  - @kohaku-ui/spec@0.3.0
  - @kohaku-ui/composer@0.3.0
  - @kohaku-ui/sandbox@0.3.0

## 0.2.0

### Patch Changes

- [#18](https://github.com/yosuque/kohaku/pull/18) [`108b3b3`](https://github.com/yosuque/kohaku/commit/108b3b33465050592df72d35bed8cf9ab16d6711) Thanks [@yosuque](https://github.com/yosuque)! - Stop declaring `tsx` as a runtime dependency of the published CLI. The published `kohaku` bin runs the compiled `dist/index.js`, so `npx @kohaku-ui/cli` no longer downloads tsx/esbuild; the in-repo `bin/kohaku.js` launcher still resolves tsx from the workspace.
- Updated dependencies [[`642330d`](https://github.com/yosuque/kohaku/commit/642330d89c85b47716a28b0a7fde36097e7e50ef), [`ffff046`](https://github.com/yosuque/kohaku/commit/ffff046628f1779bbc9b1a1a4c9d4256f82a9cd3), [`cf2623c`](https://github.com/yosuque/kohaku/commit/cf2623cd2688969db1156d0817ffff08bbe3f610), [`8f6fe5a`](https://github.com/yosuque/kohaku/commit/8f6fe5aaee025c83c8494f5dc4bd97a2a7513b11), [`cec01e1`](https://github.com/yosuque/kohaku/commit/cec01e166d2947fe8b4bbbfbe5c306c33aaccf99), [`b922703`](https://github.com/yosuque/kohaku/commit/b9227038c12dcaf790697b5ca8f1e70c98abc154), [`01ed79f`](https://github.com/yosuque/kohaku/commit/01ed79fb52322acafabe89736561d8a66b2ccd39), [`1c2a1da`](https://github.com/yosuque/kohaku/commit/1c2a1da8760ce3af8a49d90d803f6a574c851bbe), [`a318995`](https://github.com/yosuque/kohaku/commit/a318995245309f7b492b52a44fbae1a8c891a353), [`cb9f653`](https://github.com/yosuque/kohaku/commit/cb9f6538511151dd59980cc5e98c19d16f3f099d)]:
  - @kohaku-ui/composer@0.2.0
  - @kohaku-ui/spec-core@0.2.0
  - @kohaku-ui/sandbox@0.2.0
  - @kohaku-ui/evals@0.2.0
  - @kohaku-ui/spec@0.2.0

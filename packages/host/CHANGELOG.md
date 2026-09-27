# @kohaku-ui/host

## 0.4.0

### Minor Changes

- [#55](https://github.com/yosuque/kohaku/pull/55) [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049) Thanks [@yosuque](https://github.com/yosuque)! - Add `@kohaku-ui/host`, a new package: `createKohakuHost()` wires the default Port implementations
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

### Patch Changes

- Updated dependencies [[`fcd4eb7`](https://github.com/yosuque/kohaku/commit/fcd4eb7c8c6608030d4f9045648a305fa2e5992f), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`cc17b7b`](https://github.com/yosuque/kohaku/commit/cc17b7bc3c96e49b1b74197ac20cd7a3d8ee0b47), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`5d167cb`](https://github.com/yosuque/kohaku/commit/5d167cb386cc1f91102644f8a99bd5b5c2949ce0), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049)]:
  - @kohaku-ui/registry@0.4.0
  - @kohaku-ui/host-core@0.4.0
  - @kohaku-ui/host-rest@0.4.0
  - @kohaku-ui/storage-memory@0.4.0
  - @kohaku-ui/spec-core@0.4.0
  - @kohaku-ui/authz-hmac@0.4.0
  - @kohaku-ui/host-mcp-apps@0.4.0
  - @kohaku-ui/data-binding@0.4.0
  - @kohaku-ui/composer@0.4.0
  - @kohaku-ui/semantic-llm@0.4.0
  - @kohaku-ui/intents@0.4.0
  - @kohaku-ui/llm@0.4.0

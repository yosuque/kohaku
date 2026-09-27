# @kohaku-ui/host

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

### Patch Changes

- Updated dependencies [[`eb67e28`](https://github.com/yosuque/kohaku/commit/eb67e28455ab36683e61eaa03d4b9edf8def8a5d), [`3d523bf`](https://github.com/yosuque/kohaku/commit/3d523bf339ff7d114feea684dfcbc9c161a5f039), [`5a07b1a`](https://github.com/yosuque/kohaku/commit/5a07b1adbcb1545bbc35df0c6df9ed54a22fcf29), [`8df82f6`](https://github.com/yosuque/kohaku/commit/8df82f661b601ac986049302d888ee058bcde27d), [`36392f0`](https://github.com/yosuque/kohaku/commit/36392f05d3e4fa8426e6e6ab24c50081cc057595), [`cb0129e`](https://github.com/yosuque/kohaku/commit/cb0129e1ab7085ece6208169d206c5fc271c6d15), [`e9f7d34`](https://github.com/yosuque/kohaku/commit/e9f7d34b62c169b2e56af970f68ade6d2ff1b31c)]:
  - @kohaku-ui/storage-memory@0.4.0
  - @kohaku-ui/composer@0.4.0
  - @kohaku-ui/semantic-llm@0.4.0
  - @kohaku-ui/host-core@0.4.0
  - @kohaku-ui/spec-core@0.4.0
  - @kohaku-ui/host-rest@0.4.0
  - @kohaku-ui/host-mcp-apps@0.4.0
  - @kohaku-ui/authz-hmac@0.4.0
  - @kohaku-ui/data-binding@0.4.0
  - @kohaku-ui/intents@0.4.0
  - @kohaku-ui/registry@0.4.0
  - @kohaku-ui/llm@0.4.0

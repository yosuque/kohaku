---
"@kohaku-ui/host": minor
"@kohaku-ui/cli": minor
---

Add `@kohaku-ui/host`, a new package: `createKohakuHost()` wires the default Port implementations
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
`@modelcontextprotocol/server` (declared an optional peer dependency of this package).

`kohaku init`'s generated `server/app.ts` and `kohaku scaffold ports`'s scaffold are both rewired onto
`createKohakuHost`: the generated project's direct `@kohaku-ui/*` dependencies drop from 15 to 10 (host-rest
/ host-core / semantic-llm / storage-memory / authz-hmac / registry are no longer imported directly), and
`scaffold ports` now generates only a `DomainPort` (`ports.ts`) plus an Intent catalog (`intents.ts`, new
file) instead of hand-writing all four Ports — 2 TODOs instead of 5.

See `docs/design.md` decision #52 for the full rationale, including why MCP is a separate subpath.

**Before its first release, a maintainer must bootstrap the new package** (`node scripts/npm-bootstrap.mjs
--publish`, run from a maintainer's own terminal) — see `docs/runbooks/release.md`, "First publish of a new
package": npm can only register a trusted publisher for a package that already exists on the registry, so
`@kohaku-ui/host`'s own first publish cannot go through `release.yml`'s OIDC flow the way every other
package's release already does.

# @kohaku-ui/host

## 0.5.0

### Minor Changes

- [#81](https://github.com/yosuque/kohaku/pull/81) [`7dada20`](https://github.com/yosuque/kohaku/commit/7dada207c923752a410219d26bd073216ee5814d) Thanks [@yosuque](https://github.com/yosuque)! - Structural refactoring, round two (behavior-preserving):
  
  - `@kohaku-ui/host/mcp-http` (new subpath): `createMcpHttpServer`, the Streamable-HTTP scaffold (Host/Origin guards, echoed-Origin CORS, OPTIONS preflight, size-capped body pre-read, stateless `createMcpHandler` wiring) that `apps/sample-mcp` used to carry inline. `@modelcontextprotocol/node` becomes an optional peer dependency, needed only for this subpath. Defaults follow the server `kohaku init --mcp` generates; every place the sample answers differently is an explicit option. The init template itself still carries its own copy and switches after this release.
  - `@kohaku-ui/host-core`: `buildActionManifestSafely` and `recordComposedAndFallback`, the order-neutral delivery helpers both host profiles now call (each host keeps its own step order and `onError` endpoint names; characterization tests pin them).
  - `@kohaku-ui/spec-core`: `src/ports.ts` is now a barrel over one file per Port under `src/ports/` (plus `theme-tokens.ts`); every exported name and import path is unchanged.
  - `@kohaku-ui/host-rest`: the compose pipeline helpers (capability issuance, fixation host) live in `routes/compose-pipeline.ts`.
  - `@kohaku-ui/cli`: one registration module per command under `cli/src/cli/`, result printers next to their runners as `format*` functions; `--help` output and exit codes are unchanged (pinned by a help snapshot test).

### Patch Changes

- Updated dependencies [[`7dada20`](https://github.com/yosuque/kohaku/commit/7dada207c923752a410219d26bd073216ee5814d), [`4742970`](https://github.com/yosuque/kohaku/commit/4742970f69c41259e940f656bf7605e42cb3f141)]:
  - @kohaku-ui/host-core@0.5.0
  - @kohaku-ui/spec-core@0.5.0
  - @kohaku-ui/host-rest@0.5.0
  - @kohaku-ui/host-mcp-apps@0.5.0
  - @kohaku-ui/composer@0.5.0
  - @kohaku-ui/lineage@0.5.0
  - @kohaku-ui/authz-hmac@0.5.0
  - @kohaku-ui/data-binding@0.5.0
  - @kohaku-ui/intents@0.5.0
  - @kohaku-ui/llm@0.5.0
  - @kohaku-ui/registry@0.5.0
  - @kohaku-ui/semantic-llm@0.5.0
  - @kohaku-ui/storage-memory@0.5.0

## 0.4.1

### Patch Changes

- [#71](https://github.com/yosuque/kohaku/pull/71) [`690dfc1`](https://github.com/yosuque/kohaku/commit/690dfc1ee51a747d5b503c99f1e3d77c56c44612) Thanks [@yosuque](https://github.com/yosuque)! - `KohakuHostDeps.dev` (host-rest) folds the two production-facing startup warnings (governance routes open without `authorizeGovernance`, no `auth` so every request is ANONYMOUS) into a single `console.warn` line (stderr, so a stdio MCP server's stdout stays JSON-RPC only) naming whatever is unwired and the matching consequence, and prints nothing when both are wired; behavior is unchanged, and without `dev` the two `console.warn` lines are kept verbatim. `createKohakuHost`'s existing `dev` option now forwards to it (`routes.dev` overrides; pass `routes: { dev: true }` alone to fold the warnings while keeping the missing-secret throw). `@kohaku-ui/host` also re-exports `governancePolicyFromRoles` and `createGovernancePolicy` from host-rest.

- [#66](https://github.com/yosuque/kohaku/pull/66) [`33bb928`](https://github.com/yosuque/kohaku/commit/33bb9284646443c3a71c3a499b616abc2d2d6c26) Thanks [@yosuque](https://github.com/yosuque)! - `createKohakuHost` now exposes the REST profile's `approvals` / `rateLimiter` / `actionEffects` / `onRateLimited` as `host.governance`, and `attachKohakuMcp` uses them as defaults (its `deps` override), so one governance configuration applies to both profiles. It also accepts `observer` (composed with the console reporter) and `policyFor`, and logs a console line for rate-limited requests unless `routes.onRateLimited` is given (design.md decision 52).

- [#64](https://github.com/yosuque/kohaku/pull/64) [`5cfd417`](https://github.com/yosuque/kohaku/commit/5cfd417a7959c03a00587ad22b920b7fe62bf045) Thanks [@yosuque](https://github.com/yosuque)! - `createKohakuHost` now records every compose into View Lineage and every governed-Action outcome into `action.*` events by default (`recorder` / `actionAuditRecorder`, each disabled with `false`, exposed with `lineage` on the returned host), passes every other `KohakuHostDeps` field through a new `routes` option, and forwards `fallbackIntent` / `rules` to the default SemanticPort. `attachKohakuMcp` gains a `deps` option for `McpHostDeps`, and defaults the MCP profile's `onError` (via the new `createConsoleErrorReporter(...).mcp`), `recorder` and `actionAuditRecorder`, as design.md decision 52 describes.
- Updated dependencies [[`a80f17a`](https://github.com/yosuque/kohaku/commit/a80f17a8ac304def877d23df9e7b8e37ef5c7396), [`67828f4`](https://github.com/yosuque/kohaku/commit/67828f4150934eb42a61b25f44390b4c0bacf604), [`e250463`](https://github.com/yosuque/kohaku/commit/e2504639145c3baacd1843c72512e8abf4f21b08), [`cb6e91a`](https://github.com/yosuque/kohaku/commit/cb6e91afdbbc083587cd32941ebac07b0151753a), [`b712fef`](https://github.com/yosuque/kohaku/commit/b712fef7404c6af1ca6ff726890eb6ddfd44dbfc), [`5298e29`](https://github.com/yosuque/kohaku/commit/5298e299c010b6c7b088d9c778f3856a8b96e941), [`770f0c8`](https://github.com/yosuque/kohaku/commit/770f0c82b007ca211299c26dbe96b75cb922207a), [`b75f340`](https://github.com/yosuque/kohaku/commit/b75f3409c6ef1be52521e3f9d86b4fc5bf6b882f), [`6b01a1f`](https://github.com/yosuque/kohaku/commit/6b01a1fe0e8ac5f640bbc0a482a3dbe43e6b353a), [`0c4d5a2`](https://github.com/yosuque/kohaku/commit/0c4d5a298ccabe2ca47cac00f4c33730c2b915b0), [`8eb466b`](https://github.com/yosuque/kohaku/commit/8eb466bc52a5259e897d1cbc1713e57796a702e7), [`5bb982e`](https://github.com/yosuque/kohaku/commit/5bb982e2fca7d4c609d5b99b6dc71bac95dbfe55), [`06a724e`](https://github.com/yosuque/kohaku/commit/06a724e046a432e8c64af217911bb2683ab8ca9d), [`fc7b074`](https://github.com/yosuque/kohaku/commit/fc7b07414ea58b50b687cf9c72db4b2a51706df9), [`38da68b`](https://github.com/yosuque/kohaku/commit/38da68b1629df99aa7406f0068e2a479052f0cc4), [`71e17f9`](https://github.com/yosuque/kohaku/commit/71e17f9d970e01abaa8ebdf967054ad468555b56), [`690dfc1`](https://github.com/yosuque/kohaku/commit/690dfc1ee51a747d5b503c99f1e3d77c56c44612), [`5cfd417`](https://github.com/yosuque/kohaku/commit/5cfd417a7959c03a00587ad22b920b7fe62bf045), [`46ec3b2`](https://github.com/yosuque/kohaku/commit/46ec3b2f5c69e3cb5e2bdb41bd3890e3393963e4), [`90fa44b`](https://github.com/yosuque/kohaku/commit/90fa44b415b225aa4cf55e963f62d31557e3ef51), [`ab25ddc`](https://github.com/yosuque/kohaku/commit/ab25ddc5691e216e6d5d027920a0a9abbc8f4207), [`5d1f473`](https://github.com/yosuque/kohaku/commit/5d1f473064c1c489ce54441cf8c9841c1be3028d), [`206b95b`](https://github.com/yosuque/kohaku/commit/206b95b425800ec5af8f7e9ac203a8be70fd8d0b), [`b1d5322`](https://github.com/yosuque/kohaku/commit/b1d53226d659ce232156191ca9a7cdfd96e7d8ce), [`92ff930`](https://github.com/yosuque/kohaku/commit/92ff930f683391e2cd4de2a19b66a2e9ca04d49d), [`564d936`](https://github.com/yosuque/kohaku/commit/564d9369946d0c9e7b12585d8e0d7956135aa1db), [`de43fd1`](https://github.com/yosuque/kohaku/commit/de43fd11f926c5a8516997e8134f45c628517209), [`806c5f2`](https://github.com/yosuque/kohaku/commit/806c5f222097eaf6599a1fc12a5c24c11e83886f), [`643ee07`](https://github.com/yosuque/kohaku/commit/643ee070fe2eb84b9186b0bb9db7f5f767a4d4c0), [`be2d02b`](https://github.com/yosuque/kohaku/commit/be2d02b70224683f49210ab0be2d98298efbad00), [`a47d21d`](https://github.com/yosuque/kohaku/commit/a47d21d8b0b6cfdddb08a7f4e53608147c8d272b), [`9c51dab`](https://github.com/yosuque/kohaku/commit/9c51dab3d986ba1bddc444f8542e41b2e5daa654), [`343ccd7`](https://github.com/yosuque/kohaku/commit/343ccd7a71d4370473640dce94f1e2e2a821b39d), [`1e0d356`](https://github.com/yosuque/kohaku/commit/1e0d3564d6296bdae557e5d96376c798a3759b5f), [`7fa1981`](https://github.com/yosuque/kohaku/commit/7fa1981c6e574ba3e9f4eb570b88304c65565011), [`7c92cc4`](https://github.com/yosuque/kohaku/commit/7c92cc433e40a88f3b43eaeba7fd0af1a8755cad), [`8bd2e93`](https://github.com/yosuque/kohaku/commit/8bd2e93a305b2cfb12ddc394a8044b9dd9ca6378), [`a936266`](https://github.com/yosuque/kohaku/commit/a9362668b281564bc09a3b4a20233f8e1294bf41), [`837b4d2`](https://github.com/yosuque/kohaku/commit/837b4d27d3273daa9aa9d33b94e27c041a30c0ff), [`656de8e`](https://github.com/yosuque/kohaku/commit/656de8ec3aeb1ee311e25688b88437d450d9dfd9), [`adb2744`](https://github.com/yosuque/kohaku/commit/adb27442a9169eb74e803e88ec52d54db3a944b2), [`21e1438`](https://github.com/yosuque/kohaku/commit/21e143897d1fe4e3e28764b3aaada9f9589880ca), [`f8ecb4c`](https://github.com/yosuque/kohaku/commit/f8ecb4c71ba780378849c27c8ccdc6a14b31dcdc), [`632f2d8`](https://github.com/yosuque/kohaku/commit/632f2d8f711bf73192f026973876e068ec4837bf), [`718b9e0`](https://github.com/yosuque/kohaku/commit/718b9e01c9f015881cc49db41af26e1d54c53519)]:
  - @kohaku-ui/registry@0.4.1
  - @kohaku-ui/host-core@0.4.1
  - @kohaku-ui/host-rest@0.4.1
  - @kohaku-ui/spec-core@0.4.1
  - @kohaku-ui/data-binding@0.4.1
  - @kohaku-ui/host-mcp-apps@0.4.1
  - @kohaku-ui/authz-hmac@0.4.1
  - @kohaku-ui/composer@0.4.1
  - @kohaku-ui/lineage@0.4.1
  - @kohaku-ui/storage-memory@0.4.1
  - @kohaku-ui/semantic-llm@0.4.1
  - @kohaku-ui/intents@0.4.1
  - @kohaku-ui/llm@0.4.1

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

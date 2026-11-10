# @kohaku-ui/host

## 0.7.0

### Minor Changes

- [#138](https://github.com/yosuque/kohaku/pull/138) [`2f5fa15`](https://github.com/yosuque/kohaku/commit/2f5fa156e84262d3380d5fda9cfce133382e8589) Thanks [@yosuque](https://github.com/yosuque)! - Raise the minimum runtimes: Node from 24.22.1 to **26.12.1** and Python (the `kohaku-ui` distribution) from 3.12 to **3.13**. Every published package's `engines.node` is now `>=26.12.1`, and so is the `package.json` that `kohaku init` generates; `kohaku-ui` now declares `requires-python = ">=3.13"`. CI now verifies exactly one version of each runtime, and the declared floor is that version (CONTRIBUTING.md §2), so Node 24 and Python 3.12 are no longer tested. Projects still on Node 24 or Python 3.12 should upgrade before taking this release.

### Patch Changes

- Updated dependencies [[`2f5fa15`](https://github.com/yosuque/kohaku/commit/2f5fa156e84262d3380d5fda9cfce133382e8589)]:
  - @kohaku-ui/authz-hmac@0.7.0
  - @kohaku-ui/composer@0.7.0
  - @kohaku-ui/data-binding@0.7.0
  - @kohaku-ui/host-core@0.7.0
  - @kohaku-ui/host-mcp-apps@0.7.0
  - @kohaku-ui/host-rest@0.7.0
  - @kohaku-ui/intents@0.7.0
  - @kohaku-ui/lineage@0.7.0
  - @kohaku-ui/llm@0.7.0
  - @kohaku-ui/registry@0.7.0
  - @kohaku-ui/semantic-llm@0.7.0
  - @kohaku-ui/spec-core@0.7.0
  - @kohaku-ui/storage-memory@0.7.0

## 0.6.0

### Minor Changes

- [#127](https://github.com/yosuque/kohaku/pull/127) [`687d437`](https://github.com/yosuque/kohaku/commit/687d437df3117305fc9c69bc33142ff1ad4ff55a) Thanks [@yosuque](https://github.com/yosuque)! - `StoragePort` gains an optional **compare-and-set**, so several host instances sharing one redis / postgres no longer silently lose each other's promotion-state and fixation updates (SPEC Appendix 12, REST-CONF-001 [Draft], design.md [#79](https://github.com/yosuque/kohaku/issues/79)).
  
  - **spec-core**: `PromotionState.revision?` (also in `PromotionStateSchema` / `spec/schemas`), `StoragePort.supportsCompareAndSet?: true`, a four-state `expectedRevision` option on `putPromotionState`, `putFixation` and `deleteFixation` (omitted = unconditional, `null` = must not exist, `""` = must exist and carry no `revision`, any other string = must equal), the new `StorageConflictError` (`code: "STORAGE_CONFLICT"`) a mismatch throws without writing, and the `CONFLICT` `HostErrorCode`, plus the `singleProcess` marker. Adapters that do not declare the extension may keep ignoring the option, so existing adapters and fake ports stay valid. The batch `putPromotionStates` stays unconditional, so on a port that declares the extension the lineage service writes bulk nominations one candidate at a time, conditional on the revision the scan loaded, and skips a candidate that lost the race (no `component.nominated` for it) instead of rolling back an approve another instance recorded.
  - **storage-memory / storage-redis / storage-postgres**: memory, redis and postgres declare it. The file port honors `expectedRevision` (against the snapshot re-read inside its in-process lock) but does **not** declare `supportsCompareAndSet` — its lock does not span processes, so two processes sharing a data directory can still lose updates — and both it and memory mark themselves `singleProcess: true`. redis uses `WATCH` / `MULTI` / `EXEC` (no Lua) on a dedicated connection it opens lazily from the shared client (offline queue and auto-resend off; a reconnect between WATCH and EXEC is refused as a conflict; close() closes it, even for an injected client; the ACL needs `WATCH` / `UNWATCH`); postgres uses one conditional `UPDATE` / `INSERT ... ON CONFLICT DO NOTHING` / `DELETE` on the payload's JSON `revision` (SQLSTATE `40001` also maps to the conflict), with no schema change. `@kohaku-ui/port-contracts` gets an opt-in `requireCompareAndSet` case group.
  - **lineage**: every promotion snapshot write now carries a fresh `revision` and is conditional on the one the candidate was loaded with; `act()` re-reads the stored revision right before recording its audit event and throws `StorageConflictError` if it moved. Fixation `unfixate` / `invalidate` / `refreshFingerprint` / `replace` pass the revision they read (`fixate` stays an unconditional human overwrite). The persisted promotion state now has a `revision` key.
  - **host-core / host-rest / host-mcp-apps**: `StorageConflictError` is answered with `409 CONFLICT` (REST also reports it to `onError` under `storage.conflict`; the self-heal `invalidate` / `refreshFingerprint` treat a lost race as a silent no-op) and the fixed message `the resource was modified concurrently; reload and retry` (`STORAGE_CONFLICT_MESSAGE`; a new `conflict` kind of `classifyHostError`), never retried inside the host; MCP returns the same message as a tool error; `applyCatalogMigration` reports a lost race as a skipped step.
  - **host**: `createKohakuHost` warns once when a custom `storage` declares neither `supportsCompareAndSet` nor `singleProcess`.
  - **Upgrade note**: a record written before revisions existed is unversioned and is guarded too (a writer that read it expects `""`, "present, no revision"); an old-version writer can still overwrite unconditionally, so upgrade every writer before relying on the extension. A recorded `component.reviewed` approve whose state write lost the race was not applied.
  - Python port (`kohaku-ui` on PyPI): the same, with `UNSET` meaning "no expectation" (and `""` the unversioned-record state) and keyword-only `expected_revision` parameters on the `StoragePort` Protocol methods (a custom Python port with the old signatures now fails type checking; at runtime it keeps working).

### Patch Changes

- [#113](https://github.com/yosuque/kohaku/pull/113) [`f4a51cf`](https://github.com/yosuque/kohaku/commit/f4a51cfe7caad84c8269201a880d10b14a401c68) Thanks [@yosuque](https://github.com/yosuque)! - `createMcpHttpServer` (`@kohaku-ui/host/mcp-http`) no longer crashes the process on a request-target the URL parser rejects (for example `GET //`, `//[` or `//x:99999`, which parse as protocol-relative references). The URL was parsed outside any error handling whenever `path` or `routes` was set, so the throw became an unhandled rejection. Such a request is now answered with 400 and a JSON-RPC `-32600` `Invalid Request` error.
- Updated dependencies [[`8274641`](https://github.com/yosuque/kohaku/commit/82746415eb6e7188590d6523fab94e1d41b167fe), [`1d36145`](https://github.com/yosuque/kohaku/commit/1d36145aaaa7d536139bd9c3e2fe9fdbbddcb2f6), [`a6d485e`](https://github.com/yosuque/kohaku/commit/a6d485ef80f441f12ff6340748c8965bb6e578d2), [`0aad4eb`](https://github.com/yosuque/kohaku/commit/0aad4ebd9645542e65da006fabc6fb7cbf850bee), [`2e2cc38`](https://github.com/yosuque/kohaku/commit/2e2cc38451e56bd569e7d8f885bf04ba873b95b7), [`05f2c6d`](https://github.com/yosuque/kohaku/commit/05f2c6d6f51a86e237a285a8e83e353571733a92), [`0d7d372`](https://github.com/yosuque/kohaku/commit/0d7d372a05ab7307d455dd0020fecd25e028fc9f), [`4e28451`](https://github.com/yosuque/kohaku/commit/4e284512c2db9a0e2ac0bd8ab118689fbebe5c10), [`ad4ee22`](https://github.com/yosuque/kohaku/commit/ad4ee22db5d73dcaee0527dc037740325504be85), [`fe69027`](https://github.com/yosuque/kohaku/commit/fe690270abbd5f93c7fbd34fbf11cfc2a9dc2eb7), [`8a7ae32`](https://github.com/yosuque/kohaku/commit/8a7ae3289494017a47d400974140e1bfa809f795), [`f4912b4`](https://github.com/yosuque/kohaku/commit/f4912b47606c8e7595c1bf8642d8a84608f50e75), [`8fb2d04`](https://github.com/yosuque/kohaku/commit/8fb2d0419712e14951821934bfe489c558a87c07), [`b9261af`](https://github.com/yosuque/kohaku/commit/b9261af8790bd7cb184ba846f1c6324037c66947), [`e4ae97d`](https://github.com/yosuque/kohaku/commit/e4ae97d43bc90c75370da22ec5f13ed83ce22a0a), [`235333e`](https://github.com/yosuque/kohaku/commit/235333edc2277461e59ac7c2b38e0e3d2262722a), [`156e8fb`](https://github.com/yosuque/kohaku/commit/156e8fbfe2e87bcf31bb457d1d194cdf5f7946c1), [`7878e0e`](https://github.com/yosuque/kohaku/commit/7878e0ee6f57c9100f8e6d9c39e22ac39be11c58), [`8d50be6`](https://github.com/yosuque/kohaku/commit/8d50be647b2cc19d7fce639803c31169f4a6a49d), [`687d437`](https://github.com/yosuque/kohaku/commit/687d437df3117305fc9c69bc33142ff1ad4ff55a)]:
  - @kohaku-ui/lineage@0.6.0
  - @kohaku-ui/host-core@0.6.0
  - @kohaku-ui/host-rest@0.6.0
  - @kohaku-ui/authz-hmac@0.6.0
  - @kohaku-ui/spec-core@0.6.0
  - @kohaku-ui/host-mcp-apps@0.6.0
  - @kohaku-ui/data-binding@0.6.0
  - @kohaku-ui/registry@0.6.0
  - @kohaku-ui/intents@0.6.0
  - @kohaku-ui/semantic-llm@0.6.0
  - @kohaku-ui/composer@0.6.0
  - @kohaku-ui/llm@0.6.0
  - @kohaku-ui/storage-memory@0.6.0

## 0.5.0

### Minor Changes

- [#90](https://github.com/yosuque/kohaku/pull/90) [`ec72334`](https://github.com/yosuque/kohaku/commit/ec723342ee08ec94982950caf0584b79fbd23b83) Thanks [@yosuque](https://github.com/yosuque)! - Raise the minimum Node version from 22 to 24.22.1: every published package's `engines.node` is now `>=24.22.1`, and so is the `package.json` that `kohaku init` generates. Node 22 is no longer tested in CI (the matrix is now Node 24 and 26), so the declared floor follows what is actually verified. Projects still on Node 22 should upgrade Node before taking this release.

- [#81](https://github.com/yosuque/kohaku/pull/81) [`7dada20`](https://github.com/yosuque/kohaku/commit/7dada207c923752a410219d26bd073216ee5814d) Thanks [@yosuque](https://github.com/yosuque)! - Structural refactoring, round two (behavior-preserving):
  
  - `@kohaku-ui/host/mcp-http` (new subpath): `createMcpHttpServer`, the Streamable-HTTP scaffold (Host/Origin guards, echoed-Origin CORS, OPTIONS preflight, size-capped body pre-read, stateless `createMcpHandler` wiring) that `apps/sample-mcp` used to carry inline. `@modelcontextprotocol/node` becomes an optional peer dependency, needed only for this subpath. Defaults follow the server `kohaku init --mcp` generates; every place the sample answers differently is an explicit option. The init template itself still carries its own copy and switches after this release.
  - `@kohaku-ui/host-core`: `buildActionManifestSafely` and `recordComposedAndFallback`, the order-neutral delivery helpers both host profiles now call (each host keeps its own step order and `onError` endpoint names; characterization tests pin them).
  - `@kohaku-ui/spec-core`: `src/ports.ts` is now a barrel over one file per Port under `src/ports/` (plus `theme-tokens.ts`); every exported name and import path is unchanged.
  - `@kohaku-ui/host-rest`: the compose pipeline helpers (capability issuance, fixation host) live in `routes/compose-pipeline.ts`.
  - `@kohaku-ui/cli`: one registration module per command under `cli/src/cli/`, result printers next to their runners as `format*` functions; `--help` output and exit codes are unchanged (pinned by a help snapshot test).

### Patch Changes

- [#85](https://github.com/yosuque/kohaku/pull/85) [`b06ee97`](https://github.com/yosuque/kohaku/commit/b06ee972794cb1c64dba2a23114791c13f9de9f6) Thanks [@yosuque](https://github.com/yosuque)! - Raise the MCP TypeScript SDK floor to the 2.3 line: `@modelcontextprotocol/server` / `client` / `core` `^2.3.1` (were `^2.0.0`), `@modelcontextprotocol/node` `^2.1.1`, `@modelcontextprotocol/ext-apps` `^2.0.3`. The peer ranges of `@kohaku-ui/host-mcp-apps` (`server`), `@kohaku-ui/host` (`server`, `node`) and `@kohaku-ui/mcp-renderer` (`ext-apps`) follow, and `kohaku init --mcp` now generates projects that depend on `@modelcontextprotocol/server` `^2.3.1` and `@modelcontextprotocol/node` `^2.1.1`. No source change was needed for the types.
  
  Observed behavior change of the Tasks extension (`io.modelcontextprotocol/tasks`) under SDK 2.3 (the published 0.4.0 declares `^2.0.0`, so its users already resolve SDK 2.3.x):
  
  - SDK 2.0.0 rejected `tasks/get` / `tasks/cancel` with `-32601` before kohaku's handlers ran. Since SDK 2.3.0 (SEP-2663) the SDK lets those two names through when a schema-explicit handler is registered, which kohaku does, so they are now reachable. The SDK also requires `Mcp-Name: <taskId>` on them (SDK clients send it); a request without it is rejected with `-32020` before dispatch.
  - `AttachOptions.tasksEnabled` unset (the default, unchanged): no behavior change. The extension is neither declared nor registered, `tasks/get` / `tasks/cancel` still answer `-32601`, and the compose family stays synchronous.
  - `AttachOptions.tasksEnabled: true`: `tasks/get` and `tasks/cancel` went from unreachable to working. A task-backed `kohaku_compose` can now be polled to `completed` and cancelled over the wire.
  
  The `host-mcp-apps` tripwire tests were updated accordingly, and cancellation is now tested through a real `tasks/cancel`. The default of `tasksEnabled` is a separate product decision and is left unchanged.

- [#87](https://github.com/yosuque/kohaku/pull/87) [`184f84f`](https://github.com/yosuque/kohaku/commit/184f84f28ce53aaa241d7df017f3fec13b9e3380) Thanks [@yosuque](https://github.com/yosuque)! - MCP Streamable HTTP CORS: the preflight now also allows the standard `mcp-method` and `mcp-name` request headers (SEP-2243). The MCP SDK client sends them on modern-era requests and the server's HTTP entry validates them, so a cross-origin browser caller was rejected at the preflight before. This applies to `createMcpHttpServer` (`@kohaku-ui/host/mcp-http`) and to the server `kohaku init --mcp` generates. `Mcp-Param-<Name>` headers (sent only for tools declaring `x-mcp-header`) are not in the default list because a CORS allow-list cannot wildcard a prefix; a product that declares one adds it through the `corsAllowHeaders` option.
- Updated dependencies [[`b06ee97`](https://github.com/yosuque/kohaku/commit/b06ee972794cb1c64dba2a23114791c13f9de9f6), [`ec72334`](https://github.com/yosuque/kohaku/commit/ec723342ee08ec94982950caf0584b79fbd23b83), [`7dada20`](https://github.com/yosuque/kohaku/commit/7dada207c923752a410219d26bd073216ee5814d), [`b336fcb`](https://github.com/yosuque/kohaku/commit/b336fcbcefb08f8eb8240f5a61cf45db4a43721e), [`4742970`](https://github.com/yosuque/kohaku/commit/4742970f69c41259e940f656bf7605e42cb3f141), [`2a0bcd6`](https://github.com/yosuque/kohaku/commit/2a0bcd6eb50b5317c79c2e59345f52487b7ca6e6)]:
  - @kohaku-ui/host-mcp-apps@0.5.0
  - @kohaku-ui/authz-hmac@0.5.0
  - @kohaku-ui/composer@0.5.0
  - @kohaku-ui/data-binding@0.5.0
  - @kohaku-ui/host-core@0.5.0
  - @kohaku-ui/host-rest@0.5.0
  - @kohaku-ui/intents@0.5.0
  - @kohaku-ui/lineage@0.5.0
  - @kohaku-ui/llm@0.5.0
  - @kohaku-ui/registry@0.5.0
  - @kohaku-ui/semantic-llm@0.5.0
  - @kohaku-ui/spec-core@0.5.0
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

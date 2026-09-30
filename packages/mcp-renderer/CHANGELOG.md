# @kohaku-ui/mcp-renderer

## 0.4.1

### Patch Changes

- [#64](https://github.com/yosuque/kohaku/pull/64) [`cb6e91a`](https://github.com/yosuque/kohaku/commit/cb6e91afdbbc083587cd32941ebac07b0151753a) Thanks [@yosuque](https://github.com/yosuque)! - Types only, no wire change: the pending-approval descriptor is now a named `ApprovalRequiredInfo` type exported from spec-core (typing `ErrorEnvelope["error"]["approval"]` and every consumer, with `issues` typed as `ActionParamIssue[]`), and `ActionManifest` / `ActionManifestEntry` are defined once in spec-core and re-exported from host-core, renderer-core and client under their existing names (design.md decisions 62-64).

- [#64](https://github.com/yosuque/kohaku/pull/64) [`bfe34a9`](https://github.com/yosuque/kohaku/commit/bfe34a9120037d4e79073a157876c36f01cb742c) Thanks [@yosuque](https://github.com/yosuque)! - `bootMcpRenderer` accepts a `disclosure` option (`"off"` | `"attributes"` | `"label"`, default `"off"`) that is passed to `SpecView`, so the AI-generation disclosure of design.md decision 66 can be switched on in the MCP Apps widget. The default leaves the rendered DOM unchanged.

- [#66](https://github.com/yosuque/kohaku/pull/66) [`dfccc53`](https://github.com/yosuque/kohaku/commit/dfccc53f4f7e5fc7ff89faea0de73945dc13e4f9) Thanks [@yosuque](https://github.com/yosuque)! - The MCP renderer boot now maps a structured `RATE_LIMITED` tool error from `kohaku_resolve_binding` and `kohaku_action` to a `BindingError("RATE_LIMITED", ..., { retryAfterMs })`, the same as data-binding's REST client does for a 429, instead of a generic 403 / plain `Error` that dropped the retry hint (SPEC §6.1, REST-RL-001).
- Updated dependencies [[`e250463`](https://github.com/yosuque/kohaku/commit/e2504639145c3baacd1843c72512e8abf4f21b08), [`cb6e91a`](https://github.com/yosuque/kohaku/commit/cb6e91afdbbc083587cd32941ebac07b0151753a), [`b712fef`](https://github.com/yosuque/kohaku/commit/b712fef7404c6af1ca6ff726890eb6ddfd44dbfc), [`003e360`](https://github.com/yosuque/kohaku/commit/003e3605159973f6837fccf87f83691b40839483), [`5bb982e`](https://github.com/yosuque/kohaku/commit/5bb982e2fca7d4c609d5b99b6dc71bac95dbfe55), [`f34568b`](https://github.com/yosuque/kohaku/commit/f34568bb40e3c136bfc74e9c7d10c50c812f7e18), [`06a724e`](https://github.com/yosuque/kohaku/commit/06a724e046a432e8c64af217911bb2683ab8ca9d), [`71e17f9`](https://github.com/yosuque/kohaku/commit/71e17f9d970e01abaa8ebdf967054ad468555b56), [`b1a7af7`](https://github.com/yosuque/kohaku/commit/b1a7af7f39f09f2f088298098eaae618b32e363e), [`ab25ddc`](https://github.com/yosuque/kohaku/commit/ab25ddc5691e216e6d5d027920a0a9abbc8f4207), [`206b95b`](https://github.com/yosuque/kohaku/commit/206b95b425800ec5af8f7e9ac203a8be70fd8d0b), [`7c92cc4`](https://github.com/yosuque/kohaku/commit/7c92cc433e40a88f3b43eaeba7fd0af1a8755cad), [`a936266`](https://github.com/yosuque/kohaku/commit/a9362668b281564bc09a3b4a20233f8e1294bf41), [`0a2a43b`](https://github.com/yosuque/kohaku/commit/0a2a43b5ea0cbe90df1bbe53af9137452654e477), [`f8ecb4c`](https://github.com/yosuque/kohaku/commit/f8ecb4c71ba780378849c27c8ccdc6a14b31dcdc), [`4072ca8`](https://github.com/yosuque/kohaku/commit/4072ca8c86f28c2bb79abbfc0483b2e6242b7768)]:
  - @kohaku-ui/spec-core@0.4.1
  - @kohaku-ui/data-binding@0.4.1
  - @kohaku-ui/renderer-core@0.4.1
  - @kohaku-ui/renderer-react@0.4.1

## 0.4.0

### Minor Changes

- [#62](https://github.com/yosuque/kohaku/pull/62) [`cc17b7b`](https://github.com/yosuque/kohaku/commit/cc17b7bc3c96e49b1b74197ac20cd7a3d8ee0b47) Thanks [@yosuque](https://github.com/yosuque)! - Add Governed Actions: Human-In-The-Loop tiers for `DomainPort` write operations (design.md [#62](https://github.com/yosuque/kohaku/issues/62)/[#63](https://github.com/yosuque/kohaku/issues/63)/[#64](https://github.com/yosuque/kohaku/issues/64);
  SPEC §5's ACT-PRM-001/ACT-APR-001/ACT-CNF-001, LIN-ACT-001, §6.2's MCPAPP-ACT-001).
  
  An operation may declare `tier` (`"auto"` (default) / `"confirm"` / `"approve"`) and `paramsSchema`
  (kohaku's own closed JSON Schema subset — `type`, `properties`, `required`,
  `additionalProperties: false`, `enum`, `minimum`/`maximum`, `minLength`/`maxLength`, `items`, `maxItems`,
  `x-message`; deliberately no `pattern`, to avoid both ReDoS and a JS/Python regex-dialect mismatch).
  `spec-core`'s `validateActionParams`/`assertValidActionParamsSchema` (env-neutral, dependency-free, pinned
  byte-for-byte against the Python port via the cross-language golden) enforces the schema before
  `DomainPort.invoke` ever runs, on every write surface alike: REST's `POST /binding/action`, MCP's
  `${prefix}_action`, and the client-side `preflightAction` check `renderer-core` runs before either.
  
  `"approve"`-tier actions are gated by a new stateless, short-lived HMAC-signed `ApprovalPort`
  (`@kohaku-ui/authz-hmac`'s `createHmacApprovalPort`, `"kohaku-approval.v1."`-prefixed tokens, 300s default
  TTL) bound to `(action, payloadHash, requesterId, tenant)`; self-approval is refused at issuance, and a
  verification failure the host cannot classify is treated as a denial (fail-closed). An optional
  `ApprovalStore` adds single-use enforcement. REST gains `POST /approvals` (mints a token as an authorized
  approver, governance kind `action.approve`) and both the REST body and the MCP action tool's input gain
  optional `confirmed`/`approval` fields; a gate failure is `422 ACTION_PARAMS_INVALID` / `403
  APPROVAL_REQUIRED` on REST (with `error.issues`/`error.approval`) and the MCP structured-tool-error
  equivalent.
  
  A compose response optionally carries an **Action manifest** (REST's `actions?` on
  `/compose`/`/events`/`event: spec`; MCP's `_meta["kohaku/actions"]`) mapping each governed action name to
  `{tier, paramsSchema?, confirmMessage?}` — placed outside the `UISpec` itself, next to the capability, so
  it never affects `specHash` or the cache key. `renderer-core`'s `preflightAction` consults it client-side
  before a write round-trip; `renderer-react`/`renderer-wc`/`mcp-renderer` thread `confirm`/`requestApproval`
  hooks through (`renderer-react` ships a `globalThis.confirm`-backed default for the `"confirm"` tier; there
  is no framework-neutral default for `"approve"`, so that tier stays gated until a product wires its own
  hook). `@kohaku-ui/client`/`@kohaku-ui/data-binding` gain typed `ACTION_PARAMS_INVALID`/`APPROVAL_REQUIRED`
  error codes and `confirmed`/`approval` request options. A host that records action outcomes to lineage does
  so under a distinct `action.*` event family (`action.invoked`/`action.denied`/`action.approvalRequested`/
  `action.approved`), carrying `payloadHash` but never the payload's own field values.
  
  The Python port (`python/kohaku`) mirrors the full surface (`kohaku.spec.action_params`,
  `kohaku.host_core.action_gate`/`action_audit`, `POST /approvals`, the MCP action-tool gate), and
  `apps/sample-api` / `python/examples/sales-api` demonstrate both tiers end to end (`annotate`: confirm,
  `publish`: approve) — see the [user guide](../docs/user-guide.md)'s "Governed actions: tiers" section.
  
  **Behavior changes to check when upgrading.** (1) `POST /binding/action` and the MCP action tool now
  reject, before `DomainPort.invoke` runs, any action that is not in the DomainPort's own
  `listOperations()` — previously such an action was invoked ungated. It is rejected with the same response
  as a missing write scope and recorded as `action.denied`. A product whose `listOperations()` omits an
  operation it still expects to be invoked must declare it. (2) `validateActionParams` rejects a payload
  property named `__proto__`, `constructor` or `prototype` at any depth (issue code `unsafeKey`), whatever
  the schema's `additionalProperties` says.

- [#57](https://github.com/yosuque/kohaku/pull/57) [`b303d70`](https://github.com/yosuque/kohaku/commit/b303d702e1530698401c28c6ff50074ef632dac6) Thanks [@yosuque](https://github.com/yosuque)! - Add `@kohaku-ui/mcp-renderer`, a new package: the shared renderer that runs inside an MCP Apps iframe,
  distributed for reuse outside this repository (it used to live only inside `apps/sample-mcp`).
  
  - `.` — `loadRendererHtml(): Promise<string>` reads this package's own pre-built, single-file
    `dist/renderer.html` (the core kohaku component set, no product-specific implementations). **Zero npm
    dependencies** — a consumer that only wants the stock renderer installs nothing beyond this package.
  - `./boot` — `bootMcpRenderer({ registerImpls?, root? })` is the source the core build itself is built from,
    and what a product rebuilds with its own component implementations baked in (mirroring the Web app's
    registry overlay). Its `@kohaku-ui/renderer-react` / `renderer-core` / `data-binding` / `spec-core` /
    `@modelcontextprotocol/ext-apps` / `react` / `react-dom` dependencies are all optional peer dependencies —
    `.` never imports `./boot`, so they are never installed by a plain `npm install @kohaku-ui/mcp-renderer`.
  
  `apps/sample-mcp`'s own renderer (sales-domain implementations baked in) is now a thin rebuild against
  `./boot` instead of the renderer's original home.
  
  `kohaku init --mcp` generates an MCP front door on top of the always-generated REST one:
  `server/mcp-server.ts` (`attachMcpServer`, wiring the same host `server/ports.ts` builds onto
  `@kohaku-ui/host/mcp`'s `attachKohakuMcp`, with `@kohaku-ui/mcp-renderer`'s `loadRendererHtml` and typed
  MCP tools from the generated Intent catalog), `server/mcp.ts` (stdio, `npm run mcp`) and
  `server/mcp-http.ts` (Streamable HTTP on :8788, `npm run mcp:http`), plus a
  `claude_desktop_config.example.json` and `scripts/claude-desktop.mjs` (`npm run mcp:claude-desktop`
  registers the project with Claude Desktop, backing up its existing config to `.bak` first; `-- --print`
  previews the merge without writing anything — the real config is only ever touched by a person running
  this script themselves).
  
  `kohaku init`'s generated `server/app.ts` is split into `server/ports.ts` (`createPorts`, the
  `createKohakuHost()` call) + `server/app.ts` (the REST-specific facet-views / health routes on top of it),
  so the new MCP front door builds the same host without importing Hono routes it does not need.
  
  See `docs/design.md` decision [#56](https://github.com/yosuque/kohaku/issues/56) for the full rationale.
  
  **Before its first release, a maintainer must bootstrap the new package** (`node scripts/npm-bootstrap.mjs
  --publish`, run from a maintainer's own terminal) — see `docs/runbooks/release.md`, "First publish of a new
  package": npm can only register a trusted publisher for a package that already exists on the registry, so
  `@kohaku-ui/mcp-renderer`'s own first publish cannot go through `release.yml`'s OIDC flow the way every
  other already-published package's release does.

### Patch Changes

- Updated dependencies [[`5f1bbbd`](https://github.com/yosuque/kohaku/commit/5f1bbbd09fe1edb984a7b0f5a0c5212c3da628ea), [`cc17b7b`](https://github.com/yosuque/kohaku/commit/cc17b7bc3c96e49b1b74197ac20cd7a3d8ee0b47), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`5d167cb`](https://github.com/yosuque/kohaku/commit/5d167cb386cc1f91102644f8a99bd5b5c2949ce0), [`bd2d484`](https://github.com/yosuque/kohaku/commit/bd2d484826bec86c78dcb720502740494a672ea8)]:
  - @kohaku-ui/renderer-core@0.4.0
  - @kohaku-ui/renderer-react@0.4.0
  - @kohaku-ui/spec-core@0.4.0
  - @kohaku-ui/data-binding@0.4.0

# @kohaku-ui/admin-react

## 0.4.0

### Minor Changes

- [#58](https://github.com/yosuque/kohaku/pull/58) [`fcd4eb7`](https://github.com/yosuque/kohaku/commit/fcd4eb7c8c6608030d4f9045648a305fa2e5992f) Thanks [@yosuque](https://github.com/yosuque)! - Add catalog migration: deprecate a part, roll out a replacement gradually, and bulk-rewrite the fixations
  still pinned on the old one (see `docs/design.md` decision [#65](https://github.com/yosuque/kohaku/issues/65)).
  
  - `@kohaku-ui/registry`: `ComponentDefinition` gains `deprecated?` (`{reason, since?, replacedBy?: {type,
    version?}, sunset?}`) and a TS-only `migrateProps?(props)` hook next to `fallback`. `resolveCatalog`
    validates that every `replacedBy` resolves in the merged catalog. A deprecated part drops out of the L1
    generation vocabulary but keeps validating Specs that already reference it, and the catalog fingerprint
    folds in a `!deprecated` suffix per such entry (every other entry's fingerprint contribution is
    unaffected). New `stagedCatalogFor({ stable, next, inRollout })` builds a `catalogFor`-shaped function for
    canary-rolling a migrated catalog in per tenant (tenant-neutral traffic always gets `stable`).
  - `@kohaku-ui/lineage`: `FIXATION_EVENT_TYPES` gains `intent.migrated`, recorded by a new
    `Fixations.replace(intentHash, pinnedSpec, { approver, guard, planId })` that rewrites a fixation's
    pinned structure in place (TOCTOU-guarded on the caller's observed revision/fixatedAt/structureHash/
    catalogFingerprint). `PromotionCandidate` also gains `origin` (kit/generatorVersion/model, read from
    `component.generated` and kept across every transition) — a promotion-review gap noted since U2.
  - `@kohaku-ui/host-core`: new `analyzeCatalogImpact` (broken fixations, deprecated-part usage, published
    promotions on a deprecated/removed part, origin-kit mismatches) and `planCatalogMigration` /
    `applyCatalogMigration` / `verifyCatalogMigrationPlan` (plan a bulk rewrite, revalidate it against the
    target catalog, then commit it through a host-supplied fixation-replace surface).
  - `@kohaku-ui/host-rest`: `GET /catalog` now serializes `deprecated` on each component (MAY, omitted when
    the part isn't deprecated).
  - `@kohaku-ui/client`: `SerializedComponentDef` / `CatalogResponse` gain `deprecated` /
    `SerializedDeprecation`; `PromotionCandidateView` gains `origin` / `PromotionOriginView`.
  - `@kohaku-ui/cli`: new `kohaku migrate plan --data-dir --catalog --out` (read-only) and `kohaku migrate
    apply --plan --approver --data-dir` (commits it; not safe to run concurrently with a live host sharing
    `--data-dir`).
  - `@kohaku-ui/admin-react`: the promotion card shows the candidate's generation kit/generatorVersion when
    known (`origin`, EN + JA copy).
  
  Fully additive: a catalog with no deprecated parts, a fixation store with no `intent.migrated` events, and a
  promotion record with no `origin` are all byte-identical to before this change.

- [#55](https://github.com/yosuque/kohaku/pull/55) [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049) Thanks [@yosuque](https://github.com/yosuque)! - Add `kohaku explain <requestId>` and Kohaku DevTools (`@kohaku-ui/admin-react/devtools`), answering "why
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

- Updated dependencies [[`fcd4eb7`](https://github.com/yosuque/kohaku/commit/fcd4eb7c8c6608030d4f9045648a305fa2e5992f), [`5f1bbbd`](https://github.com/yosuque/kohaku/commit/5f1bbbd09fe1edb984a7b0f5a0c5212c3da628ea), [`cc17b7b`](https://github.com/yosuque/kohaku/commit/cc17b7bc3c96e49b1b74197ac20cd7a3d8ee0b47), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`5d167cb`](https://github.com/yosuque/kohaku/commit/5d167cb386cc1f91102644f8a99bd5b5c2949ce0), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049)]:
  - @kohaku-ui/client@0.4.0
  - @kohaku-ui/renderer-core@0.4.0
  - @kohaku-ui/spec-core@0.4.0
  - @kohaku-ui/sandbox@0.4.0

## 0.3.0

### Minor Changes

- [#25](https://github.com/yosuque/kohaku/pull/25) [`71ee5a7`](https://github.com/yosuque/kohaku/commit/71ee5a7efb14ec43c082cba471ff302044992643) Thanks [@yosuque](https://github.com/yosuque)! - New package: the governance console (View Lineage / Analytics / Promotion review / Fixation) the sample's Admin page shipped with, now as embeddable React components. It talks to the host only through `@kohaku-ui/client` (inject a `KohakuClient`), takes an `AdminMessages` dictionary for i18n, follows renderer-core `ThemeTokens` via `--kohaku-color-*`, and keeps the sha256-identical promotion preview (direct sandbox mount). Product-specific pieces are slots: `toolbar`, `extraTabs`, `promotionDefaults`. Depends only on `client` + `renderer-core` + `sandbox` + `spec-core` (never `renderer-react` or `host-rest`); `apps/sample-web`'s Admin page is now a thin wrapper over it.

- [#32](https://github.com/yosuque/kohaku/pull/32) [`cf54c4e`](https://github.com/yosuque/kohaku/commit/cf54c4e305d6776ceafdf218758ead4d35467369) Thanks [@yosuque](https://github.com/yosuque)! - Governance console review fixes: unhandled rejections, thresholds, RBAC boundary, promotion actions, and acknowledgement.
  
  - **Unhandled rejections ([#8](https://github.com/yosuque/kohaku/issues/8)):** `useLineage` and `useFixations` now `.catch` their GET calls (guarded by the same `stillCurrent()` staleness check every data hook already uses): a 403 becomes the role explanation (`describeDeniedOperation`), anything else the generic `fetchFailed` text — surfaced via `notify` instead of an unhandled promise rejection. New message keys: `lineage.opRead` / `lineage.fetchFailed`, `fixations.opRead` / `fixations.fetchFailed`.
  - **Threshold refetch (4.1):** `promotionMinUses` / `fixationMinUses` are now fetched once per `(client, tenant)` by `AdminProvider` and exposed through `useAdmin()`; `usePromotions` and `useFixations` read them from context instead of each issuing their own `GET /analytics/summary` on every reload. `AdminProvider` (and `KohakuAdmin`) gain an optional `tenant` prop for this.
  - **`/ui` boundary ([#10](https://github.com/yosuque/kohaku/issues/10)):** `describeDeniedOperation` (renamed from `deniedMessage`) and `TIER_COLOR` move from the generic `/ui` subpath to the package root (`rbac.ts` / `tiers.ts`) — they are domain vocabulary (RBAC / session semantics, generation-tier identity), not presentation primitives. `describeDeniedOperation` also now distinguishes a 401 (`authRequiredMessage`, new message key — "sign in again") from a 403 `CAPABILITY_DENIED` (`deniedMessage`, the existing role explanation).
  - **Acknowledgement on the wire ([#9](https://github.com/yosuque/kohaku/issues/9), carried from the `@kohaku-ui/client` review):** the Promotions tab now sends `acknowledgedSuggestion: true` when the reviewer ticked the acknowledgement for a suggestion-bearing candidate approval (omitted otherwise). **Breaking (0.x):** carrying it required changing `PromotionCardProps.onAction`'s signature from `(kind, draft?)` to `(candidate, kind, draft?, opts?)` — a positional change, not an additive one — since both `PromotionCard` and `PromotionCardProps` are root exports of this package.
  - **"all" filter ([#15](https://github.com/yosuque/kohaku/issues/15)):** the Promotions tab's "all" status filter is now a plain read-only `GET /promotions` (via `promotion.list`), same as every other status — it no longer fires the side-effecting `promotion.evaluate` as a side effect of merely viewing the list. Extracting new candidates is now an explicit "Extract candidates" toolbar button (`evaluateButton`) that calls `promotion.evaluate` and reloads.
  - **Withdraw vs. unpublish (4.9):** `PromotionActionKind` gains `"unpublish"`. Both still call `PromotionsClient.withdraw` on the wire, but the reviewer-facing operation label (`opWithdraw` vs. new `opUnpublish`) and success notice (`withdrawnNotice`, reworded, vs. new `unpublishedNotice`) now differ by whether the candidate was already published.
  - **Cleanup (4.7):** `runPromotionAction` is extracted out of `PromotionsTab`'s JSX; `PromotionCard` is wrapped in `memo`, its query-path combination is computed via `useMemo`, and busy state is now per-card (`busyArtifactId`) instead of disabling every card while any one action is in flight. Stale plan-round references (R7 / R10 / "Task 4 fix round 1" / "Task 6" / "Task 8" / "B2") are removed from `theme.ts`, `ui.tsx`, and `draft.ts`'s comments; `PromotionDefaults` / `initialDraft`'s doc comments now describe the real prefill precedence (suggestion → product `initialDraftFor` → built-in `genericInitialDraft`).
  - **README (4.8):** documents the host prerequisite (`createKohakuRoutes` must wire `lineage` / `promotions` / `fixations` — the `kohaku init` starter does not yet), adds `zod` to the install line, and documents `authRequiredMessage` / the evaluate button / the root-vs-`/ui` boundary.

- [#25](https://github.com/yosuque/kohaku/pull/25) [`c451acd`](https://github.com/yosuque/kohaku/commit/c451acdd720210ce0f0f852446b69e91615584f2) Thanks [@yosuque](https://github.com/yosuque)! - The package root no longer exports the thirteen generic UI primitives (`card`, `Field`, `Empty`, `smallButton`, `StatCard`, `StatusBadge`, `BarRow`, `sectionTitle`, `selectStyle`, `TextAreaField`, `ErrorBanner`, `TIER_COLOR`, `deniedMessage`) alongside its domain API — they move to a new `@kohaku-ui/admin-react/ui` subpath. The root now carries only `KohakuAdmin`, the tabs, the hooks, `AdminMessages`/`defaultAdminMessages`, and the `NoticeKind`/`NotifyFn` types used by `AdminProvider`'s `onNotice` (those two stay on the root even though they're defined alongside the primitives). If your app imports any of the thirteen from the package root, switch that import to `@kohaku-ui/admin-react/ui`; every other import (`KohakuAdmin`, `AdminMessages`, etc.) is unaffected. This package has not been published yet, so this is a record of the change rather than a migration for existing consumers.

- [#29](https://github.com/yosuque/kohaku/pull/29) [`cd12831`](https://github.com/yosuque/kohaku/commit/cd12831667055a0d7aec31453dcc6a7e3448e47c) Thanks [@yosuque](https://github.com/yosuque)! - LLM auto-extraction of the promotion schema (advisory). `createPromotions` gains a `suggestSchema` hook, called fail-open at auto-nomination; `@kohaku-ui/evals` ships the reference extractor (`createSchemaExtractor`, stamped `l2-schema-extraction@0.1`) next to the judge, whose L2 rubric is now 0.4 with a `suggestion_fidelity` criterion. The proposal is persisted on the candidate, exposed as an additive optional `suggestion` on the candidate JSON, audited as `component.schemaSuggested`, and the reviewer's edits are audited as `component.schemaEdited`. `summarizeLineage` adds `review` (nominated → reviewed turnaround, zero-edit acceptances) and `promotions.schemaSuggested / schemaEdited`. `@kohaku-ui/admin-react`'s Promotions tab prefills from the proposal, shows a per-field diff and requires an acknowledgement before approving.
  
  **Note for consumers who never supply a schema (no `draft`/`suggestion` passed to `judge()`):** the default gate is unchanged. A later fix (see the `@kohaku-ui/evals` / `@kohaku-ui/lineage` changesets for the judge-fidelity / rubric-variant follow-up) made `judge()` drop `suggestion_fidelity` entirely (rather than auto-scoring it 1) and score the remaining criteria under exactly `l2PromotionRubricV0_3`'s own weights whenever neither a `draft` nor a `suggestion` is known, so a no-schema consumer no longer sees the +0.10 inflation this note originally warned about. Pinning `l2PromotionRubricV0_3` explicitly remains available but is no longer necessary for that reason. **`rubricVersion` in the persisted verdict always names the configured rubric** (`"0.4"` for the built-in default, even in this dropped-criterion case) — `rubricVariant: "no-schema"` is what records that `suggestion_fidelity` was dropped, not a version change.

### Patch Changes

- Updated dependencies [[`a26f9be`](https://github.com/yosuque/kohaku/commit/a26f9be35f5702287e79f67f13bd3298bfb73bc5), [`ad51284`](https://github.com/yosuque/kohaku/commit/ad5128464169d389e0c462c59184d411ba359d8e), [`cffc1aa`](https://github.com/yosuque/kohaku/commit/cffc1aac259bfdc8f22c48ae57427a809853924e), [`9e227c9`](https://github.com/yosuque/kohaku/commit/9e227c9dd2ceda6b9c2483296be4b4dc0e090bfd), [`cd12831`](https://github.com/yosuque/kohaku/commit/cd12831667055a0d7aec31453dcc6a7e3448e47c)]:
  - @kohaku-ui/spec-core@0.3.0
  - @kohaku-ui/client@0.3.0
  - @kohaku-ui/renderer-core@0.3.0
  - @kohaku-ui/sandbox@0.3.0

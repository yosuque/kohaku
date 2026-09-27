# @kohaku-ui/composer

## 0.4.0

### Minor Changes

- [#61](https://github.com/yosuque/kohaku/pull/61) [`5d167cb`](https://github.com/yosuque/kohaku/commit/5d167cb386cc1f91102644f8a99bd5b5c2949ce0) Thanks [@yosuque](https://github.com/yosuque)! - Add Policy as Code (design.md [#69](https://github.com/yosuque/kohaku/issues/69)/[#70](https://github.com/yosuque/kohaku/issues/70)): a declarative JSON policy file (`KohakuPolicyFileSchema`,
  spec-core) layers per-tenant overrides — `allowL2`, `budget.dailyTokens`, `rateLimits`, `governance.roles`
  — onto a product-supplied base `ComposePolicy`, without a code change or redeploy. `host-core`'s
  `createPolicyRuntime` builds the runtime (`policyFor`, `rateLimiter`, `rolesFor`, `reload`); `loadPolicyFile`
  reads and validates one from disk. Every function-shaped `ComposePolicy` field (`routeTier`, `fewShot`,
  `designSystem`, `fixedSpecs`, `l2Smoke`, `selectComponents`, `extraRules`) has no schema field at all and
  always comes from the base policy.
  
  Add rate limiting: a new `RateLimitStore` port (spec-core) and `createMemoryRateLimitStore`/
  `createRateLimiter` (host-core) back the policy file's `rateLimits` section. The REST profile
  (`host-rest`) checks it before the compose-family routes and returns `429` with a `RATE_LIMITED` error
  envelope and, when reported, an HTTP `Retry-After` header; the client SDK exposes the new
  `KohakuHostError.retryAfterMs`. The MCP Apps profile (`host-mcp-apps`) checks it before its 6 tool
  handlers and returns a structured tool error (`structuredContent.error.code: "RATE_LIMITED"`, with
  `retryAfterMs` when reported) instead. `host-rest` also gains `governancePolicyFromRoles`, a
  `GovernanceEvaluator` that re-resolves a `PolicyRuntime`'s roles on every call rather than baking them in
  once. `@kohaku-ui/lineage` gains a `policy.applied` audit event (`Lineage.policyApplied`), recorded only
  when a policy reload actually changes the effective policy.
  
  **Cache-isolation fix (SPEC CMP-DET-002, new)**: a session's L2 (free-generation) availability
  (`allowL2`/`routeTier`) is now folded into the compose cache key's fingerprint (`policyFingerprint`'s new
  `tierGate` component), so a cache entry produced under an L2-permissive tenant/policy can no longer be
  served to a session where L2 is disallowed. This is additive to `ComposeBudget`, whose `check` hook now
  optionally receives a `BudgetCheckContext` (tenant/tier/spentTokens/elapsedMs) and gains an optional
  `onUsage` hook, fired once per compose that actually generated.
  
  **Compatibility note**: a policy file (or base `ComposePolicy`) that never sets `allowL2` or `routeTier`
  produces a byte-identical fingerprint to before this change — no cache impact. An environment with
  `allowL2: true` or a `routeTier` configured (in code or via a policy file) will see exactly one cache miss
  per previously-cached intent/tenant/policy combination the first time it composes after upgrading, as the
  new `tierGate` fingerprint component takes effect; every subsequent call caches normally.

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

- [#55](https://github.com/yosuque/kohaku/pull/55) [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049) Thanks [@yosuque](https://github.com/yosuque)! - Makes a fallback's reason and an `onError` observation honest about *why* generation degraded, instead of
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
- Updated dependencies [[`fcd4eb7`](https://github.com/yosuque/kohaku/commit/fcd4eb7c8c6608030d4f9045648a305fa2e5992f), [`cc17b7b`](https://github.com/yosuque/kohaku/commit/cc17b7bc3c96e49b1b74197ac20cd7a3d8ee0b47), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`5d167cb`](https://github.com/yosuque/kohaku/commit/5d167cb386cc1f91102644f8a99bd5b5c2949ce0)]:
  - @kohaku-ui/registry@0.4.0
  - @kohaku-ui/spec-core@0.4.0
  - @kohaku-ui/llm@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [[`a26f9be`](https://github.com/yosuque/kohaku/commit/a26f9be35f5702287e79f67f13bd3298bfb73bc5), [`ad51284`](https://github.com/yosuque/kohaku/commit/ad5128464169d389e0c462c59184d411ba359d8e), [`79d4307`](https://github.com/yosuque/kohaku/commit/79d430747add16102065f9ff9f0f7c1071750094), [`b19b7c1`](https://github.com/yosuque/kohaku/commit/b19b7c156304c2e63ce9d1851d5bd0479442fd62), [`cffc1aa`](https://github.com/yosuque/kohaku/commit/cffc1aac259bfdc8f22c48ae57427a809853924e)]:
  - @kohaku-ui/spec-core@0.3.0
  - @kohaku-ui/llm@0.3.0
  - @kohaku-ui/registry@0.3.0

## 0.2.0

### Minor Changes

- [#23](https://github.com/yosuque/kohaku/pull/23) [`ffff046`](https://github.com/yosuque/kohaku/commit/ffff046628f1779bbc9b1a1a4c9d4256f82a9cd3) Thanks [@yosuque](https://github.com/yosuque)! - `provenance.generatorVersion` / `provenance.kit` (both MAY, spec/SPEC.md §2.1 Appendix item 13):
  the composer now stamps the Spec's `provenance` with the generator identity (`ComposePolicy.generatorVersion`)
  and design kit (`designSystem.kit`'s `{id, version}`) in effect at composition time, whenever either is
  set — on every tier, and preserved unchanged through a cache hit or an L1→L0 fixation.
  
  `mountSandbox`'s `kitCss?: string` option is now `@deprecated` (kept, unchanged, backward compatible) in
  favor of `kit?: DesignKitStylesheet | string | ((node, spec) => DesignKitStylesheet | string | undefined)`.
  A versioned `DesignKitStylesheet` (`{id, version, css}`) is compared against the Spec's own
  `provenance.kit` and a mismatch is reported via `bridge.onTelemetry({kind: "kit-mismatch"})` — fail-open,
  never blocking rendering (**SPEC-KIT-001**, SHOULD). This closes the gap where a design kit's CSS and
  vocabulary version had no verification mechanism (a vocabulary bump with no matching CSS change, or vice
  versa, previously rendered unstyled markup with no signal).
  
  `kit`'s resolver form, called with the frame's own `node`/`spec`, is available on both `SandboxFrame`
  (React) and `<kohaku-surface>`'s `context.sandbox.kit` (WC, closing the prior React/WC asymmetry). A host
  can read `spec.provenance.kit` inside it to serve each artifact the stylesheet it was actually composed
  against, rather than one stylesheet for the whole surface — replacing `kitCss: ""`'s all-or-nothing
  rollback (previously, silencing a regression in newly generated artifacts by clearing `kitCss` also
  stripped styling from every already-generated artifact under the old kit).
  
  Fully additive: existing `kitCss` callers, and Specs whose provenance carries neither field, are
  unaffected. `PROMPT_REVISION` and `policyFingerprint` are untouched by this change.

- [#23](https://github.com/yosuque/kohaku/pull/23) [`cf2623c`](https://github.com/yosuque/kohaku/commit/cf2623cd2688969db1156d0817ffff08bbe3f610) Thanks [@yosuque](https://github.com/yosuque)! - **`PROMPT_REVISION` bumped `"12"` → `"13"`** (`packages/composer/src/prompt.ts` / the Python mirror `python/kohaku/src/kohaku/composer/prompt.py`): the L2 design brief's spacing line no longer presupposes a "## Design system" section that may not be in the prompt (it now reads "one consistent spacing scale throughout; use the design tokens or kit utilities when the prompt supplies them" instead of "consistent spacing from the design tokens (…)"); `designKitPromptFragment`/`design_kit_prompt_fragment` gained an empty-input guard (an empty `classes`/`utilities`/`namespaces` no longer emits a dangling, self-contradicting heading); the "Skeleton of a well-formed widget body" section is now shown **iff a kit declares its own `skeleton`**, with no fallback of any kind to the built-in `k-card`/`k-grid-3`/`k-table` skeleton for a different kit (the built-in `DEFAULT_KIT_VOCABULARY` now declares its own `skeleton`/`skeleton=` field, rather than the function special-casing it by object identity — the identity check silently dropped the skeleton, and therefore changed the prompt, for any structurally-equivalent-but-not-identical `DEFAULT_KIT_VOCABULARY` reference, e.g. across an ESM dual-package install or a `ComposePolicy` that round-trips through JSON); kit classes are now presented **sorted by name** rather than in `Object.entries`/dict insertion order (closing a real TS/Python divergence: JS sorts integer-like keys like `"2col"` ahead of every other key regardless of declaration order, while Python dict iteration keeps insertion order); and "component class(es)" was renamed to "kit class(es)" throughout the L2 prompt and its repair feedback, to stop colliding with the Spec's own `ComponentDefinition` vocabulary. The built-in kit's own prompt bytes are unchanged by the empty-input guard and the skeleton-declaration change (it always showed its skeleton, before and after) — the sort and the rename are the only bytes that moved for it. **What to expect:** every cached L2 generation is separated by this revision bump, so the first request after upgrading pays a fresh L1/L2 generation cost instead of a cache hit (as with every prior `PROMPT_REVISION` bump); no action is required, and already-promoted/fixated artifacts are unaffected (only the *generation* cache is keyed by this). A product supplying its **own** design kit (`designSystem.kit`) that relied on the old fallback (omitting its own `skeleton` and expecting to see the built-in one) will now see no Skeleton section at all — pass your kit's own `skeleton` explicitly if you want one (see docs/user-guide.md's bring-your-own-kit section).
  
  `policyFingerprint`/`policy_fingerprint`'s design-kit material no longer carries a `classesOrder` entry (`packages/composer/src/context.ts` / `context.py`): now that kit classes are presented sorted by name, insertion order no longer affects the L2 prompt, so the material that used to carry it separately has nothing left to protect. Separately, the material's `skeleton` entry for the built-in kit changes from an absent key to `DEFAULT_KIT_SKELETON`'s text, reflecting the field it now declares. Both are one-time fingerprint changes for any caller using `designSystem.kit` (same "your compose cache is repartitioned once" caveat as any `policyFingerprint` material change; combined with the `PROMPT_REVISION` bump above, the practical effect is the same fresh-generation cost already described).
  
  `l2PromotionRubric` (the L2 promotion judge) moves to version `"0.3"`: `visual_quality`'s weight moves `0.1` → `0.2` and `generality`'s moves `0.15` → `0.05` (`generality` and `schema_inferability` are two ways of asking "is this a reusable, well-made component", which made `generality` the natural weight source for `visual_quality`'s increase); its description now also covers `never use fixed pixel widths — fill the container width` and `loading` states (previously part of the L2 generation brief but not scored), and replaces the unscorable two-word "restrained color" with the L2 brief's own countable wording ("use the primary color for one emphasis at most; tone colors only when they carry meaning"). `RubricCriterion`/`Criterion` also gains an optional `floor`, and `l2PromotionRubric`'s `safety` criterion sets one at `0.5`: previously a `safety` score of `0` could still be outvoted by the other five criteria under the weighted average (e.g. full marks elsewhere clears the default `passScore` of `0.6` even at `safety=0`) — `safety` is the one criterion that reads the generated HTML's semantic behavior the way a human reviewer would, so a low score there should never be compensated away by good looks elsewhere. `scoreWithRubric`'s verdict now fails (`pass: false`) whenever any floored criterion's score falls strictly below its floor, regardless of the weighted-average score, and reports which criteria vetoed via the new `JudgeVerdict.vetoedBy`/`JudgeVerdict.vetoed_by` (always present, `[]` when nothing vetoed). **What to expect:** a judge call using the default rubric can now flip from `pass: true` to `pass: false` purely because of a low `safety` score, even when the overall weighted score is unchanged — check `vetoedBy` when auditing a promotion-review outcome that looks surprising. Existing consumers also see a further score shift from the weight rebalance and the new description wording (on top of the `"0.2"` rubric's own shift when `visual_quality` was added). `rubricVersion`/`rubric_version` is an audit stamp only — no data migration. A consumer who wants the exact pre-`"0.3"` behavior (weights, description, and no floor) can pin it explicitly: `judge({ ..., rubric: l2PromotionRubricV0_2 })` (Python: `rubric=l2_promotion_rubric_v0_2`), newly exported alongside the existing `l2PromotionRubricV0_1`/`l2_promotion_rubric_v0_1`.

- [#23](https://github.com/yosuque/kohaku/pull/23) [`8f6fe5a`](https://github.com/yosuque/kohaku/commit/8f6fe5aaee025c83c8494f5dc4bd97a2a7513b11) Thanks [@yosuque](https://github.com/yosuque)! - Design kit for L2 free generation: `DesignSystemGuide.kit` (built-in `DEFAULT_KIT_VOCABULARY`) presents component classes (`k-card`, `k-kpi`, `k-table`, …) and a token-driven utility subset to the model and enables the `L2_UNKNOWN_CLASS` lint; `mountSandbox` / `SandboxFrame` / `<kohaku-surface>` inject renderer-core's `defaultDesignKit.css` by default (`kitCss: ""` opts out, any other string is your own kit). The L2 system prompt now carries a design brief. Also, `collectL2Issues` and `collectUnknownKitClasses` are now exported from `@kohaku-ui/composer`'s root barrel (`collectL2Issues` was previously internal).
  
  This CSS injection is still not keyed by prompt revision or by the compose cache key, so it still applies to every L2 artifact the host renders — not only new generations — including artifacts already in the compose cache, already fixated, and already promoted into a catalog. Concretely, previously generated HTML now picks up `*,*::before,*::after{box-sizing:border-box}`, `html,body{margin:0;padding:0}`, the `body` rule setting font family/size/line-height/colour/background (an artifact that set only `color` and relied on the browser's white background now sits on the theme background instead, e.g. going dark in dark mode), the `h1`–`h4` heading scale, and the `:focus-visible` ring. An empty CSS string (`kit: ""` / `kitCss: ""` — the `SandboxFrame` prop, `mountSandbox`'s option, or `<kohaku-surface>`'s `context.sandbox.kit`) is still the per-surface opt-out; re-reviewing promoted L2 catalog entries after upgrading is advisable.
  
  A separate follow-up narrows this limitation without removing it: `mountSandbox`'s `kit` option now also accepts a versioned `DesignKitStylesheet` (`{id, version, css}`, superseding the now-`@deprecated` `kitCss` string) and a per-node resolver `(node, spec) => …`. The composer stamps the kit and generator identity it composed with onto every delivered Spec (`provenance.generatorVersion` / `provenance.kit`, both MAY — spec/SPEC.md §2.1 Appendix item 13), preserved unchanged through a cache hit or a fixation, and a versioned `kit` is compared against it (`bridge.onTelemetry({kind: "kit-mismatch"})`, fail-open — SPEC-KIT-001). A resolver reading `spec.provenance.kit` can then serve each artifact the CSS it was actually written against instead of one CSS for the whole surface — the fix for the all-or-nothing rollback this note originally described (`kitCss: ""` silencing a new artifact's regression by also stripping styling from every already-generated one). See docs/user-guide.md's design-kit section ("Detecting a stale kit" / "Rolling a kit change back per artifact").

- [#23](https://github.com/yosuque/kohaku/pull/23) [`cec01e1`](https://github.com/yosuque/kohaku/commit/cec01e166d2947fe8b4bbbfbe5c306c33aaccf99) Thanks [@yosuque](https://github.com/yosuque)! - Extend the design-token vocabulary beyond colors: `font.family.*`, `font.size.*`, `space.*`, `radius.*`, `shadow.*` and `motion.*` (typed in `KnownThemeTokens`, defaulted in `defaultLightTheme` / `defaultDarkTheme`, resolvable via `resolveSizing`). The L2 design-system prompt now describes them (`PROMPT_REVISION` 12 — cached L2 generations are separated by prompt revision).

### Patch Changes

- [#23](https://github.com/yosuque/kohaku/pull/23) [`642330d`](https://github.com/yosuque/kohaku/commit/642330d89c85b47716a28b0a7fde36097e7e50ef) Thanks [@yosuque](https://github.com/yosuque)! - Expose `design-system.ts` (DEFAULT_KIT_VOCABULARY and friends) under a new `@kohaku-ui/composer/design-system` subpath, mirroring the existing `./l2-api` pattern, so node-independent downstream packages (e.g. sandbox, which sets `"types": []`) can import the design-kit vocabulary without pulling composer's full barrel — and with it `@kohaku-ui/llm`'s `process.env` usage — into their typecheck.

- [#9](https://github.com/yosuque/kohaku/pull/9) [`1c2a1da`](https://github.com/yosuque/kohaku/commit/1c2a1da8760ce3af8a49d90d803f6a574c851bbe) Thanks [@yosuque](https://github.com/yosuque)! - Bound client-supplied lineage strings (`surface`/`renderer`/`locale` to 64 chars, `specHash`/`artifactId` to 128) in host-rest's request schemas; verify a fixation's `intentHash`/`structureHash` against its own `pinnedSpec` before delivery in composer's `materializeFixation`; resolve `host-a2ui`'s per-ref data model concurrently instead of one ref at a time; and stop `<kohaku-surface>` from rebuilding its whole tree when only `onEvent`/`onNodeError`/`onActionResult` changes, plus repair properties assigned before the element was upgraded (the standard Custom Elements pattern).
- Updated dependencies [[`ffff046`](https://github.com/yosuque/kohaku/commit/ffff046628f1779bbc9b1a1a4c9d4256f82a9cd3), [`cec01e1`](https://github.com/yosuque/kohaku/commit/cec01e166d2947fe8b4bbbfbe5c306c33aaccf99), [`0bea3f0`](https://github.com/yosuque/kohaku/commit/0bea3f047c496e08be629077bdd2018db153dd75), [`6e8ae87`](https://github.com/yosuque/kohaku/commit/6e8ae870edb7c1a79a99e126a7e0bf3bacbe1c7f), [`a318995`](https://github.com/yosuque/kohaku/commit/a318995245309f7b492b52a44fbae1a8c891a353)]:
  - @kohaku-ui/spec-core@0.2.0
  - @kohaku-ui/llm@0.2.0
  - @kohaku-ui/registry@0.2.0

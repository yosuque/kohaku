# @kohaku-ui/spec

## 0.6.0

### Minor Changes

- [#128](https://github.com/yosuque/kohaku/pull/128) [`ad4ee22`](https://github.com/yosuque/kohaku/commit/ad4ee22db5d73dcaee0527dc037740325504be85) Thanks [@yosuque](https://github.com/yosuque)! - Filters on generated screens: `ComposePolicy.l1Filters` (default `false`, design.md [#78](https://github.com/yosuque/kohaku/issues/78)) makes the composer inject the Intent's filters into an L1-generated Spec deterministically, so changing a filter re-resolves the data with no recompose and no model call. The model decides nothing about the filter set or its value domain.
  
  - `@kohaku-ui/spec`: SPEC change-list item 22 and §6.1.1 (the last `event: patch` MAY carry `capability` and `actions`).
  - `@kohaku-ui/spec-core`: `FilterDescriptor` (`{ param, queryParam, paths, label, options }`) and the optional `SemanticPort.describeFilters?(intent, { tenant?, locale? })`.
  - `@kohaku-ui/intents`: `IntentDef.filters?(locale?)`, derived from `defineIntent`'s `facets` + `queries[].paramMap` for every discrete, string-valued `select` facet (numeric facets, `control: "number"`, an ambiguous `paramMap`, callback `queries`, and a `queryParam` that is also a `fixedParams` key or is shared by another Intent param on the same path are skipped). `paths` lists the template paths that map the param.
  - `@kohaku-ui/semantic-llm`: `createLlmSemanticPort` implements `describeFilters` from the catalog.
  - `@kohaku-ui/composer`: `injectFilters` (a post-step of L1 generation only, after `normalizeIds`): adds `control.select` + `state` + `state.set` event + `data.bind`, binding only the data components that read a path the descriptor governs. It falls back to the Spec as generated (never worse than not injecting) when the bind variants exceed `ComposePolicy.l1FiltersMaxVariants` (default 64: a 256-scope capability exceeds Node's 16 KiB header limit), the root is not a `layout.stack` / `layout.grid`, or the result fails `validateSpecStructure`. `ComposeTrace.filters` records `{ injected, skipped? }`. `l1Filters` joins `policyFingerprint` only when `true` (an absent key, so existing cache keys are unchanged), together with a hash of the descriptors actually used (`filterDescriptorsHash`: labels, options, paths) and the cap when not 64, so another `session.locale` (now passed to `describeFilters`, so labels follow the session language) or a tenant-specific option list is cached separately; the prompt is unchanged. `ResolvedRefs.descriptors?`, `postProcess(..., filters?)`, `postAndValidate(..., filters?)` and `composeStream`'s patch event `converged?: true` are additive. A selected filter value cannot be cleared back to "all" (no empty bind value, like the L0 cross-filter).
  - `@kohaku-ui/host-rest`: on `/compose/stream` the last convergence patch carries a replacement `capability` (issued from the finalized Spec like `/compose`'s, so it also carries the Spec's write scopes) and the Spec's `actions` manifest (`{ patch, capability?, actions? }`, SPEC §6.1.1), only when it declares `data.bind`; every other stream is byte-identical to before.
  - `@kohaku-ui/client`, `@kohaku-ui/renderer-react`: the `patch` stream event exposes the optional `capability` (and, in the client SDK, `actions`); `useSpecStream` replaces its capability with it.
  - `@kohaku-ui/host-mcp-apps` **(behaviour change independent of `l1Filters`)**: `preresolveInitialData` resolves every initial ref but at most 32 distinct non-initial bind variants eagerly, for any Spec (previously all of them, up to 256); the rest resolve on demand through `kohaku_resolve_binding`. `snapshotHtmlFor` still resolves the full set it needs.
  - Python port (`kohaku-ui` on PyPI): the same, in `kohaku.spec` (`FilterDescriptor`), `kohaku.intents`, `kohaku.semantic_llm`, `kohaku.composer` (`inject_filters`, `ComposePolicy(l1Filters=True, l1FiltersMaxVariants=...)`), `kohaku.host_rest` and `kohaku.host_mcp`; `injectFilters`, the descriptor hash and the `policy_fingerprint` bytes are pinned against TS by the cross-language golden.

### Patch Changes

- Updated dependencies [[`a6d485e`](https://github.com/yosuque/kohaku/commit/a6d485ef80f441f12ff6340748c8965bb6e578d2), [`0aad4eb`](https://github.com/yosuque/kohaku/commit/0aad4ebd9645542e65da006fabc6fb7cbf850bee), [`0d7d372`](https://github.com/yosuque/kohaku/commit/0d7d372a05ab7307d455dd0020fecd25e028fc9f), [`ad4ee22`](https://github.com/yosuque/kohaku/commit/ad4ee22db5d73dcaee0527dc037740325504be85), [`8d50be6`](https://github.com/yosuque/kohaku/commit/8d50be647b2cc19d7fce639803c31169f4a6a49d), [`687d437`](https://github.com/yosuque/kohaku/commit/687d437df3117305fc9c69bc33142ff1ad4ff55a)]:
  - @kohaku-ui/spec-core@0.6.0

## 0.5.0

### Minor Changes

- [#90](https://github.com/yosuque/kohaku/pull/90) [`ec72334`](https://github.com/yosuque/kohaku/commit/ec723342ee08ec94982950caf0584b79fbd23b83) Thanks [@yosuque](https://github.com/yosuque)! - Raise the minimum Node version from 22 to 24.22.1: every published package's `engines.node` is now `>=24.22.1`, and so is the `package.json` that `kohaku init` generates. Node 22 is no longer tested in CI (the matrix is now Node 24 and 26), so the declared floor follows what is actually verified. Projects still on Node 22 should upgrade Node before taking this release.

### Patch Changes

- Updated dependencies [[`ec72334`](https://github.com/yosuque/kohaku/commit/ec723342ee08ec94982950caf0584b79fbd23b83), [`7dada20`](https://github.com/yosuque/kohaku/commit/7dada207c923752a410219d26bd073216ee5814d), [`b336fcb`](https://github.com/yosuque/kohaku/commit/b336fcbcefb08f8eb8240f5a61cf45db4a43721e)]:
  - @kohaku-ui/spec-core@0.5.0

## 0.4.1

### Patch Changes

- Updated dependencies [[`e250463`](https://github.com/yosuque/kohaku/commit/e2504639145c3baacd1843c72512e8abf4f21b08), [`cb6e91a`](https://github.com/yosuque/kohaku/commit/cb6e91afdbbc083587cd32941ebac07b0151753a), [`b712fef`](https://github.com/yosuque/kohaku/commit/b712fef7404c6af1ca6ff726890eb6ddfd44dbfc), [`06a724e`](https://github.com/yosuque/kohaku/commit/06a724e046a432e8c64af217911bb2683ab8ca9d), [`71e17f9`](https://github.com/yosuque/kohaku/commit/71e17f9d970e01abaa8ebdf967054ad468555b56), [`ab25ddc`](https://github.com/yosuque/kohaku/commit/ab25ddc5691e216e6d5d027920a0a9abbc8f4207), [`206b95b`](https://github.com/yosuque/kohaku/commit/206b95b425800ec5af8f7e9ac203a8be70fd8d0b), [`7c92cc4`](https://github.com/yosuque/kohaku/commit/7c92cc433e40a88f3b43eaeba7fd0af1a8755cad), [`a936266`](https://github.com/yosuque/kohaku/commit/a9362668b281564bc09a3b4a20233f8e1294bf41), [`f8ecb4c`](https://github.com/yosuque/kohaku/commit/f8ecb4c71ba780378849c27c8ccdc6a14b31dcdc)]:
  - @kohaku-ui/spec-core@0.4.1

## 0.4.0

### Patch Changes

- Updated dependencies [[`cc17b7b`](https://github.com/yosuque/kohaku/commit/cc17b7bc3c96e49b1b74197ac20cd7a3d8ee0b47), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`5d167cb`](https://github.com/yosuque/kohaku/commit/5d167cb386cc1f91102644f8a99bd5b5c2949ce0)]:
  - @kohaku-ui/spec-core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [[`a26f9be`](https://github.com/yosuque/kohaku/commit/a26f9be35f5702287e79f67f13bd3298bfb73bc5), [`ad51284`](https://github.com/yosuque/kohaku/commit/ad5128464169d389e0c462c59184d411ba359d8e), [`cffc1aa`](https://github.com/yosuque/kohaku/commit/cffc1aac259bfdc8f22c48ae57427a809853924e)]:
  - @kohaku-ui/spec-core@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [[`ffff046`](https://github.com/yosuque/kohaku/commit/ffff046628f1779bbc9b1a1a4c9d4256f82a9cd3), [`cec01e1`](https://github.com/yosuque/kohaku/commit/cec01e166d2947fe8b4bbbfbe5c306c33aaccf99), [`a318995`](https://github.com/yosuque/kohaku/commit/a318995245309f7b492b52a44fbae1a8c891a353)]:
  - @kohaku-ui/spec-core@0.2.0

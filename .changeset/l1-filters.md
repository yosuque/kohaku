---
"@kohaku-ui/spec": minor
"@kohaku-ui/spec-core": minor
"@kohaku-ui/intents": minor
"@kohaku-ui/semantic-llm": minor
"@kohaku-ui/composer": minor
"@kohaku-ui/host-rest": minor
"@kohaku-ui/host-mcp-apps": minor
"@kohaku-ui/client": minor
"@kohaku-ui/renderer-react": minor
---

Filters on generated screens: `ComposePolicy.l1Filters` (default `false`, design.md #78) makes the composer inject the Intent's filters into an L1-generated Spec deterministically, so changing a filter re-resolves the data with no recompose and no model call. The model decides nothing about the filter set or its value domain.

- `@kohaku-ui/spec`: SPEC change-list item 22 and §6.1.1 (the last `event: patch` MAY carry `capability` and `actions`).
- `@kohaku-ui/spec-core`: `FilterDescriptor` (`{ param, queryParam, paths, label, options }`) and the optional `SemanticPort.describeFilters?(intent, { tenant?, locale? })`.
- `@kohaku-ui/intents`: `IntentDef.filters?(locale?)`, derived from `defineIntent`'s `facets` + `queries[].paramMap` for every discrete, string-valued `select` facet (numeric facets, `control: "number"`, an ambiguous `paramMap`, callback `queries`, and a `queryParam` that is also a `fixedParams` key or is shared by another Intent param on the same path are skipped). `paths` lists the template paths that map the param.
- `@kohaku-ui/semantic-llm`: `createLlmSemanticPort` implements `describeFilters` from the catalog.
- `@kohaku-ui/composer`: `injectFilters` (a post-step of L1 generation only, after `normalizeIds`): adds `control.select` + `state` + `state.set` event + `data.bind`, binding only the data components that read a path the descriptor governs. It falls back to the Spec as generated (never worse than not injecting) when the bind variants exceed `ComposePolicy.l1FiltersMaxVariants` (default 64: a 256-scope capability exceeds Node's 16 KiB header limit), the root is not a `layout.stack` / `layout.grid`, or the result fails `validateSpecStructure`. `ComposeTrace.filters` records `{ injected, skipped? }`. `l1Filters` joins `policyFingerprint` only when `true` (an absent key, so existing cache keys are unchanged), together with a hash of the descriptors actually used (`filterDescriptorsHash`: labels, options, paths) and the cap when not 64, so another `session.locale` (now passed to `describeFilters`, so labels follow the session language) or a tenant-specific option list is cached separately; the prompt is unchanged. `ResolvedRefs.descriptors?`, `postProcess(..., filters?)`, `postAndValidate(..., filters?)` and `composeStream`'s patch event `converged?: true` are additive. A selected filter value cannot be cleared back to "all" (no empty bind value, like the L0 cross-filter).
- `@kohaku-ui/host-rest`: on `/compose/stream` the last convergence patch carries a replacement `capability` (issued from the finalized Spec like `/compose`'s, so it also carries the Spec's write scopes) and the Spec's `actions` manifest (`{ patch, capability?, actions? }`, SPEC §6.1.1), only when it declares `data.bind`; every other stream is byte-identical to before.
- `@kohaku-ui/client`, `@kohaku-ui/renderer-react`: the `patch` stream event exposes the optional `capability` (and, in the client SDK, `actions`); `useSpecStream` replaces its capability with it.
- `@kohaku-ui/host-mcp-apps` **(behaviour change independent of `l1Filters`)**: `preresolveInitialData` resolves every initial ref but at most 32 distinct non-initial bind variants eagerly, for any Spec (previously all of them, up to 256); the rest resolve on demand through `kohaku_resolve_binding`. `snapshotHtmlFor` still resolves the full set it needs.
- Python port (`kohaku-ui` on PyPI): the same, in `kohaku.spec` (`FilterDescriptor`), `kohaku.intents`, `kohaku.semantic_llm`, `kohaku.composer` (`inject_filters`, `ComposePolicy(l1Filters=True, l1FiltersMaxVariants=...)`), `kohaku.host_rest` and `kohaku.host_mcp`; `injectFilters`, the descriptor hash and the `policy_fingerprint` bytes are pinned against TS by the cross-language golden.

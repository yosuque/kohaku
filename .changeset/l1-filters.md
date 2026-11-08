---
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

- `@kohaku-ui/spec-core`: `FilterDescriptor` (`{ param, queryParam, label, options }`) and the optional `SemanticPort.describeFilters?(intent, { tenant?, locale? })`.
- `@kohaku-ui/intents`: `IntentDef.filters?(params, locale?)`, derived from `defineIntent`'s `facets` + `queries[].paramMap` for every discrete, string-valued `select` facet (numeric facets, `control: "number"`, an ambiguous `paramMap` and callback `queries` are skipped).
- `@kohaku-ui/semantic-llm`: `createLlmSemanticPort` implements `describeFilters` from the catalog.
- `@kohaku-ui/composer`: `injectFilters` (a post-step of L1 generation only, after `normalizeIds`): adds `control.select` + `state` + `state.set` event + `data.bind`, falls back to the Spec as generated (never worse than not injecting) when there are more than 256 bind variants, the root is not a `layout.stack` / `layout.grid`, or the result fails `validateSpecStructure`. `ComposeTrace.filters` records `{ injected, skipped? }`. `l1Filters` joins `policyFingerprint` only when `true` (an absent key, so existing cache keys are unchanged); the prompt is unchanged. `ResolvedRefs.descriptors?`, `postProcess(..., filters?)`, `postAndValidate(..., filters?)` and `composeStream`'s patch event `final?: true` are additive. Labels are canonical (no locale is passed, because the Spec cache key is locale-free).
- `@kohaku-ui/host-rest`: on `/compose/stream` the last convergence patch carries a replacement `capability` (`{ patch, capability? }`, SPEC §6.1.1) issued from the finalized Spec, only when it declares `data.bind`; every other stream is byte-identical to before.
- `@kohaku-ui/client`, `@kohaku-ui/renderer-react`: the `patch` stream event exposes the optional `capability`; `useSpecStream` replaces its capability with it.
- `@kohaku-ui/host-mcp-apps`: `preresolveInitialData` resolves every initial ref but at most 32 non-initial bind variants eagerly (the rest resolve on demand through `kohaku_resolve_binding`), so a wide filter fan-out is not up to 256 upstream calls per compose.
- Python port (`kohaku-ui` on PyPI): the same, in `kohaku.spec` (`FilterDescriptor`), `kohaku.intents`, `kohaku.semantic_llm`, `kohaku.composer` (`inject_filters`, `ComposePolicy(l1Filters=True)`), `kohaku.host_rest` and `kohaku.host_mcp`; `injectFilters` and the `policy_fingerprint` bytes are pinned against TS by the cross-language golden.

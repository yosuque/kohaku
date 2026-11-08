---
"@kohaku-ui/intents": patch
"@kohaku-ui/semantic-llm": patch
"@kohaku-ui/composer": patch
---

L1 filter safety fixes (design.md #78, Codex post-merge review C7/C8/C9).

- **C9, a shape-changing filter blanked the chart** (`@kohaku-ui/intents`, `@kohaku-ui/composer`): an injected filter only swaps a bound query parameter, so a `metric` / `granularity` / `groupBy` switch left the chart's `x` / `y` naming columns the new variant no longer returns. New `FacetSpec.filterable?: boolean` (default `true`): a facet declared `false` stays a GUI facet in `toFacetView()` but is never an injected filter; the sample catalog marks those three facets. Defence in depth: when the `SemanticPort` implements the existing optional `describeShape`, the composer drops a descriptor whose option variants change the column-name set (or whose variant shape cannot be described). A port without `describeShape` must mark such facets `filterable: false` itself. The descriptors hashed into the cache key are the ones actually used, so a Spec cached before this change is simply regenerated when its filters drop.
- **C7, the filter product bypassed the Intent's params** (`@kohaku-ui/semantic-llm`): `createLlmSemanticPort`'s `describeFilters` now validates each option against the Intent's params schema (`safeParse({ ...intent.params, [param]: option })`), drops filters left with fewer than 2 options, and validates the whole cartesian product the capability would sign. A forbidden combination (a `refine`), or a product over the new `maxFilterVariants` option (default 64, the composer's `l1FiltersMaxVariants` default), yields no filters for that Intent. `DEFAULT_MAX_FILTER_VARIANTS` is exported.
- **C8, a fixation kept re-signing removed options** (`@kohaku-ui/composer`): `materializeFixation` checks the pinned Spec's `data.bind` values against the Intent's current `describeFilters` descriptors (same `queryParam` and path, subset of option values, not a hash compare). A drifted pin is `stale` (`filter options drifted`) and takes the ordinary stale / self-heal path. Without `describeFilters` (or if it throws) nothing is checked, as before.
- Python port (`kohaku-ui` on PyPI): the same `FacetSpec(filterable=...)`, shape guard (`drop_shape_changing_filters`), `vet_filters` / `max_filter_variants` and fixation check.

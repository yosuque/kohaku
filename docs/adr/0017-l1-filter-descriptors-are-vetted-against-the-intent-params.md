# 0017. L1 filter descriptors are vetted against the Intent's params

- Status: accepted
- Date: 2026-11-08
- Deciders: yosuque + Claude Code
- Phase: implementation

## Context and problem

The composer injects L1 filters from the Intent's facet declarations ([ADR-0007](0007-composer-injects-l1-filters-from-intent-facets.md)). Every variant it injects is signed into the capability. `buildFilters` enumerates each facet's options independently, and the cartesian product of those options was never checked against the Intent's params constraints.

The post-merge Codex (gpt-6-astra) review raised this as C7, and a verifier reproduced it: an Intent whose schema refused a combination (for example `private` × `detail`) had that combination read through `/binding/resolve` with a capability issued for an allowed screen.

The first fix vetted the full product of the returned descriptors. Review then showed that this still left a hole. The composer skips a filter whose current value is absent from the ref or not among its options, so the product it actually signs held that param at a value that was never validated.

## Options considered

- **Option A**: vet inside `describeFilters` (TS `createLlmSemanticPort`, Python `semantic_llm`):
  1. Validate each option on its own and drop invalid options.
  2. Drop any filter left with fewer than two options.
  3. Drop filters the composer would skip, using the same rule as `injectFilters`, applied after the per-option vetting.
  4. Validate the full product of what remains.
  - On any failure, or when the product exceeds `maxFilterVariants` (default 64), return no filters for that Intent.
- **Option B**: vet in the composer after injection, against the final binds.
- **Option C**: leave constraints to the product and document the gap.

## Decision

Chosen: **Option A** (PR #135).

- Validation goes through the catalog's own `validateParams`, else `normalizeParams`, else the params schema. This is the path GUI and NL compose actually enforce. In Python it is the only place a cross-field constraint can live, since the params DSL has no `refine`.
- The base for validation is the validated `intent.params`, with defaults filled. The ref is read through `toQueries(intent.params)`, so defaults that land in the ref are covered.
- The vetted product is a superset of the signed product, and every combination in it is validated.
- The C7 guarantee belongs to `createLlmSemanticPort`. A custom SemanticPort's `describeFilters` must vet its own output. This is documented in design #78 and the specification (EN and JA).

### Rationale

- `describeFilters` is where both the Intent definition and the catalog validator are available, and its output already feeds the descriptor hash in the cache key. Vetting there keeps cache keys consistent with what is injected.
- Option B would need the composer, which knows nothing about Intent schemas, to call back into the semantic layer for every variant.
- Fail-safe to "no filters" keeps the screen usable, because the L1 Spec still renders. It never signs an unvalidated scope.
- Option C contradicts ADR-0007's premise that the descriptor, not the model, bounds the authorised range.

## Consequences (trade-offs)

- Good:
  - Every signed variant passes the same validation as an Intent request.
  - The original repro and the "non-injected filter" repro both yield no forbidden scope, in TS and Python.
- Costs / bad:
  - An Intent with any forbidden combination loses all its filters, rather than just the offending ones.
  - `maxFilterVariants` counts the full product, while the composer's `l1FiltersMaxVariants` sums per-component products. The vetting is therefore conservative: filters on disjoint paths can be dropped even though the composer would have accepted them.
  - The two 64 limits are independent. Raising only one can stale pins created under the other.
- Revisit when: Intents need partial filter sets. An explicit allowed-combination representation would then replace the drop-all rule.

## References

- PRs: #128 (L1 filters), #135 (this decision)
- [ADR-0007](0007-composer-injects-l1-filters-from-intent-facets.md)
- design.md #78

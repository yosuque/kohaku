# 0018. Shape-changing facets are not L1 filters

- Status: accepted
- Date: 2026-11-08
- Deciders: yosuque + Claude Code
- Phase: implementation

## Context and problem

An injected L1 filter changes only `data.bind`, so the component props (for example a chart's `x` / `y` columns) stay as the model generated them. The sample enabled `l1Filters`, and three of its facets change the result's column names:
- `sales.trend` metric (revenue → units)
- `sales.trend` granularity (month → quarter)
- `sales.quarterly_summary` groupBy (region → product)

Switching one of those filters blanked the chart, because its props pointed at columns that no longer existed. This was post-merge Codex (gpt-6-astra) finding C9. A verifier reproduced it, and no test caught it: the e2e checked only for a 200.

## Options considered

- **Option A**:
  - Add an explicit opt-out per facet: `filterable?: boolean` (default true). A `filterable: false` facet is never a filter but stays in `toFacetView()`.
  - Add a composer guard as defence in depth. When the port has the existing optional `SemanticPort.describeShape`, skip any descriptor whose variants have a different column set (ignoring order) from the initial variant, or whose variant shape cannot be obtained.
- **Option B**: rewrite component props per filter state so a chart follows the new columns.
- **Option C**: guard only, with no opt-out.

## Decision

Chosen: **Option A** (PR #135), in TS and Python.
- The TS and Python sample catalogs mark metric, granularity and groupBy `filterable: false`.
- The guard adds no new port method.
- A port without `describeShape`, or an initial shape that is unknown, gets no guard. Such a port must mark shape-changing facets itself. This is documented in design #78 and the user guide (EN and JA).
- A descriptor whose option count exceeds `l1FiltersMaxVariants` is skipped before it is described, because injection would stop anyway.
- A sample e2e asserts that every injected variant's rows contain the chart's columns. A catalog-wide test checks the sample with `shapeOf`.

### Rationale

- The facet author knows whether a facet changes the result's shape. `filterable` is a cheap, explicit declaration.
- The guard catches mistakes deterministically, and its calls are bounded and memoised per variant URI. It also runs before the descriptor hash, so the cache key reflects what is injected.
- Option B would make props state-dependent, which is a new Spec capability across renderers. It is out of scope for a fix.
- Option C would leave ports without `describeShape` unprotected. domain-mcp is one: its shapes come from a static `outputSchema`, so the guard can never drop anything there.

## Consequences (trade-offs)

- Good:
  - In the sample, the only filter left on `sales.trend` is region, and it keeps every chart cell populated.
  - Shape-changing variants are no longer signed, so they return 403.
- Costs / bad:
  - With default params (region unset), `sales.trend` gets no filter at all. The `sales-trend.json` golden was regenerated accordingly.
  - Ports without `describeShape`, including domain-mcp, rely on facet authors marking shape-changing facets.
- Revisit when: Specs gain state-dependent props. At that point a shape-changing facet could become a filter again.

## References

- PRs: #128 (L1 filters), #135 (this decision)
- [ADR-0007](0007-composer-injects-l1-filters-from-intent-facets.md), [ADR-0017](0017-l1-filter-descriptors-are-vetted-against-the-intent-params.md)
- design.md #78

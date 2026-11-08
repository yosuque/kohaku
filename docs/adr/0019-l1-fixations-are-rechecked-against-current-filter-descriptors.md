# 0019. L1 fixations are re-checked against the current filter descriptors

- Status: accepted
- Date: 2026-11-08
- Deciders: yosuque + Claude Code
- Phase: implementation

## Context and problem

A fixated Spec is served pinned. Its `data.bind` values, injected filters included, are signed into fresh capabilities on every delivery. Fixation delivery used to check four things: the catalog fingerprint, the intent and structure hashes, and ref drift of the initial variant. It never checked the filter descriptors. So after an option was removed from a facet, a fixated injected Spec kept receiving capabilities for the removed scope. This was post-merge Codex (gpt-6-astra) finding C8, confirmed by a verifier.

The first fix exposed three more problems in review:
- **L0 false stales.** The check applied to every bind. An approved L0 fixation whose template carries hand-written cross-filter binds was marked stale, and so invalidated, even though nothing had drifted.
- **Fail-open on error.** When `describeFilters` threw, the check passed, and the pin's binds were signed anyway. That widened the scope.
- **Re-fixation laundering.** Fixation delivery reports `tier: "L0", cache: "fixated"`. Re-fixating an already-fixated intent therefore pinned that delivery, injected binds and all, as L0. From then on the L1-only check skipped it permanently.

## Options considered

For which pins to check:
- **(a)** Check every bind.
- **(b)** Check only binds recognised by the injection's id convention.
- **(c)** Check only pins with `provenance.tier === "L1"`. Within those, any bind not governed by a current descriptor counts as drift.

For a throwing descriptor source:
- Fail open (serve the pin), or invalidate the fixation, or a non-destructive "unavailable" outcome.

For re-fixation:
- Refuse with an error, or return the existing record idempotently.

## Decision

Chosen (PR #135, TS and Python):
- **(c), the tier gate.** On delivery, an L1 pin's bind values must be a subset of the current descriptor options for the same `queryParam` and path. Otherwise the pin is `stale` ("filter options drifted") and the normal self-heal runs.
  - The comparison is subset, not hash, so a label-only change or an added option stays fresh.
  - A port without `describeFilters` is not checked, as documented.
  - L0 pins are out of scope: their template owns their binds.
- **A new `unavailable` outcome.** When `describeFilters` throws, `materializeFixation` returns `unavailable` with the `cause`. `settleFixation` then handles the request this way:
  - it falls back to a normal compose
  - the fixation is neither invalidated nor are its binds signed
  - the failure is reported as `fixation.check` through `onSelfHealError`
- **Re-fixation is idempotent.** Lineage `fixate` never pins a fixation delivery (`provenance.cache === "fixated"`). It returns the existing record with no write and no `intent.fixated` audit event. If that record was concurrently removed, it raises `FixationNotAllowedError("fixated-delivery")`, which both REST hosts answer with 409 `CONFLICT`.

### Rationale

- Only L1 is injected. The model cannot emit `data.bind`: the generation schema forbids it, and the prompt-JSON path fails `BIND_STATE_UNKNOWN`. A2UI ingest does not create binds either. So the tier is a reliable marker of injected binds.
- (b) would rely on a naming heuristic that an L0 author can collide with.
- Gating on `policy.l1Filters` would be wrong. Pins created while the policy was on keep signing binds after it is turned off.
- Failing open widens the scope. Invalidating on a transient error would destroy a human-approved fixation. `unavailable` is fail-closed without being destructive.
- Making re-fixation idempotent closes the launder path at the one point both hosts share, without breaking a retried approval.

## Consequences (trade-offs)

- **Good:**
  - Removing a filter option takes effect for fixated L1 screens on their next delivery.
  - Approved L0 fixations are unaffected.
  - A descriptor-source outage degrades to normal compose rather than to over-signing.
- **Costs / bad:**
  - A product `extraRules` PostRule that adds binds on L1 is subject to the check, as documented.
  - `settleFixation` gains a third outcome that every host profile must handle. host-core handles it once, and Python adds `fixation.check` to the host endpoint maps.
  - Re-fixating now returns the existing pin instead of re-pinning.
- **Revisit when:** L0 binds need drift detection against their template, or fixation records start carrying the descriptor fingerprint they were created under.

## References

- PRs: #128 (L1 filters), #135 (this decision)
- [ADR-0007](0007-composer-injects-l1-filters-from-intent-facets.md), [ADR-0017](0017-l1-filter-descriptors-are-vetted-against-the-intent-params.md)
- design.md #78 and the fixation rows

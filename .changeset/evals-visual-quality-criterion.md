---
"@kohaku-ui/evals": minor
---

`l2PromotionRubric` (L2 promotion judge) gains a `visual_quality` criterion — clear visual hierarchy, consistent spacing, restrained color, right-aligned tabular numeric columns, notice-style empty/error states, no browser-default table/button/input styling, and (when the generation prompt supplied design tokens or a design kit) styles expressed with them rather than hard-coded values. The rubric moves to version `"0.2"` and existing weights are rebalanced (`safety` 0.3→0.25, `schema_inferability` 0.2→0.15, `visual_quality` 0.1 new) so all six criteria still sum to 1.0. `l1QualityRubric` is unchanged. The Python port (`kohaku.evals.judge.l2_promotion_rubric`) mirrors the same id/version/criteria for cross-language judge comparability.

Existing consumers of the default rubric see up to a 0.10 shift in L2 promotion scores because a sixth criterion was added and weights were rebalanced; `rubricVersion` is an audit stamp only (no migration). A consumer who wants to keep the old promotion behavior can pin it explicitly by passing `rubric: l2PromotionRubricV0_1` (Python: `rubric=l2_promotion_rubric_v0_1`) to `judge()` — the exact pre-`visual_quality` rubric (5 criteria, version `"0.1"`), also exported from this package.

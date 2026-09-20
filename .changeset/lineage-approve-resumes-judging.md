---
"@kohaku-ui/lineage": patch
---

`promotions.approve()` now resumes a candidate that was persisted at `judging` (for example after a crash between `judge.start` and `judge.result`) by running the judge and continuing the chain, instead of failing with `PromotionNotPublishedError`. The Python port gains the same behaviour.

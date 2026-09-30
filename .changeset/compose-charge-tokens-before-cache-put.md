---
"@kohaku-ui/composer": patch
---

`compose()` now reports `budget.onUsage` before writing the Spec cache, so with `cacheFailure: "closed"` a failing cache write no longer skips charging the tokens already spent on generation (design.md decision 69).

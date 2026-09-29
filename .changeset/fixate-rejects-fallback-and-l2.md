---
"@kohaku-ui/lineage": patch
---

`Fixations.fixate` now throws the new `FixationNotAllowedError` for a Spec carrying `provenance.fallback` or a tier-`L2` Spec, so the SPEC section 8 rule holds for every caller and not only the REST route. The Python `Fixations.fixate` enforces the same rule.

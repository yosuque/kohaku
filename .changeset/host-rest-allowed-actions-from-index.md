---
"@kohaku-ui/host-rest": patch
---

The REST compose routes now derive the capability write-scope filter from the same memoized operation index the action gate and the `actions` manifest use, so `listOperations()` is read once per host instead of twice (design.md decision 62).

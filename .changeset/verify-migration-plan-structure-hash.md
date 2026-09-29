---
"@kohaku-ui/host-core": patch
"@kohaku-ui/cli": patch
---

`verifyCatalogMigrationPlan` now also recomputes each step's structure hash from its `pinnedSpec` and compares it with `afterStructureHash`, so a plan whose `pinnedSpec` was altered without touching its hashes is rejected before `kohaku migrate apply` writes anything (design.md decision 65). The Python port mirrors the change.

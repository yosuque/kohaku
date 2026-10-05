---
"@kohaku-ui/cli": patch
---

A malformed `--header` value (no `:`, or an empty name) is now a usage error that exits 2, like the other bad arguments, in `explain`, `evidence export` and `usage export`. `explain` used to exit 1 for it, the same code as a failed request.

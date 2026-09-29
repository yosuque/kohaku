---
"@kohaku-ui/cli": patch
---

`kohaku evidence verify` now refuses a FIFO or device node in place of a pack file (it used to block forever on a FIFO) and reports one as an unexpected file, and commander's own usage errors on `evidence verify` / `evidence export` (a missing required option, an unknown option) exit 2 instead of 1, so they no longer collide with "invalid pack".

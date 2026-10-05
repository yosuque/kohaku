---
"@kohaku-ui/cli": patch
---

`kohaku init` now generates the golden fixture's `expected` right after `npm install` (one `npx vitest run` in update mode, with `CI` removed from the environment), so `npm test` in a fresh project is green instead of failing with "expected not generated". The step is best-effort: if it fails, init still succeeds and prints the manual `KOHAKU_GOLDEN_UPDATE=1 npm test` command. `InitResult` gains `goldenGenerated`, and `InitIo.run` accepts an `env` overlay (an `undefined` value removes the key).

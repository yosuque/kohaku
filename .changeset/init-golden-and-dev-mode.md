---
"@kohaku-ui/cli": patch
---

`kohaku init` now generates the golden fixture's `expected` right after `npm install` (one `npx vitest run` in update mode, with `CI` removed from the environment), so `npm test` in a fresh project is green instead of failing with "expected not generated". The step is best-effort: if it fails, init still succeeds and prints the manual `KOHAKU_GOLDEN_UPDATE=1 npm test` command. `InitResult` gains `goldenGenerated`, and `InitIo.run` accepts an `env` overlay (an `undefined` value removes the key).

The generated `server/ports.ts` now passes `routes: { dev: process.env["NODE_ENV"] !== "production" }` to `createKohakuHost` (one startup warning line on stderr instead of the two production warnings; `routes.dev` rather than the top-level `dev`, so a missing `KOHAKU_CAPABILITY_SECRET` still fails fast) and carries a commented `auth` (marked as an insecure placeholder) / `authorizeGovernance` starting point; `.env` / `.env.example` document `NODE_ENV=production`, and the generated README gains a "Before production" section.

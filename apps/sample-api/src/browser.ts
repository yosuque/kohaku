/**
 * The `./browser` export: `createApp`, usable directly in a browser with no server and no filesystem. This
 * re-exports from `app-core.ts` (not `app.ts`, the package's `"."` export) — `app-core.ts` has no Node-only
 * static import at all, and `AppDeps.repo` there is mandatory (no disk-reading default to accidentally
 * reach), unlike `app.ts`'s own `AppDeps`. See `app.ts`'s doc comment for why the two are split.
 *
 * A caller through this entry point (the static playground, U5) must supply `repo` (built from its own seed
 * data — see `SalesSeedInput`). `l2Smoke` and `otel` should also usually be left unset (see their doc
 * comments on `AppDeps`): both exist for a Node host (index.ts) to opt into.
 */

export { createHeaderIdentity, type RequestIdentity } from "./app/request-identity.js";
export { type AppDeps, createApp, type SampleApp } from "./app-core.js";
export { SalesRepo, type SalesSeedInput } from "./domain/repo.js";

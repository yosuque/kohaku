import { type AppDeps as CoreAppDeps, createApp as createAppCore, type SampleApp } from "./app-core.js";
import { SalesRepo } from "./domain/repo.js";
import { readSeedFromDisk } from "./domain/seed-fs.js";

// Re-exported for consumers outside the REST host (sample-mcp's fixation language gate) and for
// backward-compatible access to app-core.ts's other exports through this file's historical path.
export { admitFixationForLocale, FIXATION_MIN_USES, languageOf, type OutputLang } from "./app-core.js";
export type { SampleApp };

/**
 * The package's `"."` export — the Node-facing `createApp`. Identical to `app-core.ts`'s `AppDeps` except
 * `repo` is optional: omitting it reads the real demo seed from disk (`domain/seed-fs.ts`, `node:fs`), the
 * historical zero-config behavior every existing caller (index.ts, and every sample-api / sample-mcp /
 * spec-conformance test that constructs `createApp({...})` without a `repo`) still relies on unchanged.
 *
 * This file (not `app-core.ts`) is the one that imports `seed-fs.ts`, so it is the one Node-only file in
 * this pair — by design: the `./browser` export (`browser.ts`) re-exports `app-core.ts`'s `createApp`
 * directly (mandatory `repo`, no disk fallback), never this wrapper, so a browser bundle never reaches this
 * file's `node:fs`/`node:path`/`node:url` import at all.
 *
 * (An earlier version of this wrapper tried to keep the disk-reading default *inside* app-core.ts behind a
 * dynamic `import()` with a variable specifier — the same technique `@kohaku-ui/sandbox/smoke` uses for
 * jsdom/node:vm. That works for a real npm package like jsdom, resolvable via node_modules regardless of
 * how it's reached, but not for this repository's own TypeScript source: Vite/Vitest's SSR module runner
 * only rewrites a `.js`-suffixed relative specifier to the on-disk `.ts` file when it can see the specifier
 * *statically* — a variable specifier defeats that the same way it defeats a bundler's analysis, so
 * `import(moduleName)` failed at test time with "Cannot find module .../seed-fs.js". Splitting into two
 * files, as above, avoids the whole problem: no dynamic import is needed anywhere.)
 */
export type AppDeps = Omit<CoreAppDeps, "repo"> & { repo?: SalesRepo };

export async function createApp(deps: AppDeps): Promise<SampleApp> {
  return createAppCore({ ...deps, repo: deps.repo ?? new SalesRepo(readSeedFromDisk()) });
}

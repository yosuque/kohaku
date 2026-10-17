import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Do not put passWithNoTests here (across all projects): making it global would hide a total
    // loss of test files (e.g. a glob mistake). Place passWithNoTests via a local vitest.config.ts
    // only in workspaces that have no tests (see apps/sample-wc / apps/sample-web).
    //
    // The last entry, apps/playground/vitest.drift.config.ts, is listed explicitly (a file path, not a
    // directory glob) because Vitest does not flatten a `projects` array nested inside a config that was
    // itself discovered via another entry's glob (apps/playground/vitest.config.ts already matches
    // "apps/*" as the "playground" project) — this is the only way to register a second, independently
    // selectable project ("playground-drift") for the same package. It is deliberately excluded from the
    // package.json "test" script's own invocation (`--project "!playground-drift"`), since it replays real
    // recorded fixtures and is meant to be run on purpose (`pnpm vitest run --project playground-drift`),
    // not on every `pnpm test` — see that project's own config file for why.
    projects: ["packages/*", "apps/*", "cli", "spec", "apps/playground/vitest.drift.config.ts"],
    coverage: {
      // Without `include`, vitest 5's coverage report only lists files that some test actually imported
      // (its "untested files" pass returns nothing when `include` is unset), so a source file that no test
      // ever loads would be invisible instead of counted at 0%, and could never lower the thresholds below.
      // Setting `include` makes un-imported source files count as uncovered.
      //
      // Every `include` / `exclude` pattern here is written as `**/src/...` on purpose. Vitest matches these
      // globs against the path relative to the coverage root, and that root depends on how the run was
      // started: the repository root for a plain `vitest run --coverage`, but each selected project's own
      // root as soon as `--project` is given (as `pnpm test:coverage` does, to leave out playground-drift).
      // A root-anchored pattern such as `packages/*/src/**` therefore matches nothing in the second mode
      // (the report silently collapses to 0/0 files), and a root-anchored exclude silently stops excluding.
      // The leading `**/` matches both `src/x.ts` (project root) and `packages/p/src/x.ts` (repo root).
      // Test files, fixtures, scripts, build output and config files live outside any `src` directory,
      // and vitest itself always excludes node_modules and the test-file globs.
      include: ["**/src/**/*.{ts,tsx}"],
      exclude: [
        // The L2 guest shim never runs in this realm: it is emitted as a source string
        // (`buildWorkerShimJs()`) and evaluated inside a dedicated Worker in the browser, or inside a
        // `node:vm` context by the pre-delivery smoke runner. v8 therefore cannot attribute any of its
        // execution back to this file, and it lands in the report as ~0% however thoroughly it is
        // exercised -- which it is, through the smoke runner (`packages/sandbox/test`, which boots the
        // real shim against the real applier) and the bridge/parity suites. Counting it would be
        // measuring the instrumentation's blind spot rather than the tests, and it alone moves the
        // global statement figure by about six points, so it is excluded and its behaviour is guarded by
        // those tests instead. The applier (`guest/dom-applier.ts`) is NOT excluded: it runs as a plain
        // function in the trusted document, so its coverage is real.
        "**/src/guest/worker-shim.ts",
        // docs-site's config, theme and sync CLI (`.vitepress/`, `scripts/`) and its snippets are
        // build-time only: no test imports them, so v8 would report them at ~0% however correct they
        // are. They are not unguarded: the VitePress config, theme and sync CLI are exercised by the real
        // `vitepress build` that the CI docs-site job runs, and the snippets are typechecked by tsc and
        // asserted byte-identical to the Markdown they're extracted from by
        // `apps/docs-site/test/snippets.test.ts`. None of them sits under a `src` directory, so the
        // `include` above already leaves them out in either mode; these entries only document that
        // (and take effect in repo-root mode if `include` is ever widened, since the project-relative
        // path no longer contains `docs-site`). They exclude paths from the coverage count, not from
        // verification, and the thresholds below are unchanged.
        "**/docs-site/snippets/**",
        "**/docs-site/.vitepress/**",
        "**/docs-site/scripts/**",
      ],
      // A floor pinned below the measured baseline (statements 91.01 / branches 82.09 / functions 88.68 /
      // lines 92.95 under vitest 5), so a coverage regression (e.g. a whole error branch losing its test)
      // fails CI instead of silently shipping. autoUpdate is off on purpose: raising the floor is a deliberate
      // decision made when adding tests, not something a coverage run should do for us.
      thresholds: {
        statements: 88,
        branches: 76,
        functions: 88,
        lines: 88,
        autoUpdate: false,
      },
    },
  },
});

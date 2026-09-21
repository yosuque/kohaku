import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*", "cli", "spec"],
    // Do not put passWithNoTests here (across all projects): making it global would hide a total
    // loss of test files (e.g. a glob mistake). Place passWithNoTests via a local vitest.config.ts
    // only in workspaces that have no tests (see apps/sample-wc / apps/sample-web).
    coverage: {
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
      exclude: [
        "packages/sandbox/src/guest/worker-shim.ts",
        // docs-site's config, theme and sync CLI are build-time only: no test imports them, so v8
        // would report them at ~0% however correct they are, and functions coverage has essentially
        // no headroom left (0.79pp) to absorb that. They are not unguarded, though: the VitePress
        // config, theme and sync CLI are exercised by the real `vitepress build` that the CI
        // docs-site job runs, and the snippets are typechecked by tsc. A dedicated test asserting the
        // snippets byte-identical to the Markdown they're extracted from is Task 5 of the docs-site
        // plan and does not exist yet at this point in the plan. This excludes these paths from the
        // coverage count, not from verification, and the thresholds below are unchanged.
        "apps/docs-site/snippets/**",
        "apps/docs-site/.vitepress/**",
        "apps/docs-site/scripts/**",
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

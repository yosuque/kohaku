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
      exclude: ["packages/sandbox/src/guest/worker-shim.ts"],
      // A floor pinned below the measured baseline (statements 90.59 / branches 81.27 / functions 88.20 /
      // lines 92.61 as of this writing), so a coverage regression (e.g. a whole error branch losing its test)
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

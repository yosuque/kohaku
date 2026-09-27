import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "playground",
    // Most of this package's tests are plain Node (host/*.test.ts); the one UI test
    // (test/dashboard.test.tsx) overrides this per-file via a `// @vitest-environment jsdom` docblock
    // instead of paying jsdom's setup/teardown cost for every file.
    environment: "node",
    // Required for @testing-library/react's automatic afterEach cleanup (see AGENTS.md's pitfall note) —
    // only exercised by test/dashboard.test.tsx, but harmless for the plain-Node tests in this project too.
    globals: true,
    passWithNoTests: true,
    // The drift suite (vitest.drift.config.ts's "playground-drift" project) lives in this same package but
    // is registered as a separate root-level project (see the root vitest.config.ts's own `projects` list)
    // rather than nested here, since Vitest does not flatten a `projects` array defined inside a config that
    // was itself discovered via another project's glob entry — excluded here so the default `pnpm test`
    // (this project) never also picks these files up redundantly.
    exclude: ["**/node_modules/**", "test/drift/**"],
  },
});

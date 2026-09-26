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
  },
});

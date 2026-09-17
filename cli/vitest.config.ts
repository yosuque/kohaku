import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "cli",
    environment: "node",
    // The sandbox smoke helper dynamically imports jsdom on first use (packages/sandbox/src/smoke/index.ts),
    // which can exceed vitest's default 5000ms when the whole suite runs in parallel under load.
    // setupFiles pre-warms that import once (see test/setup.ts) so 20s stays enough per test.
    setupFiles: ["./test/setup.ts"],
    testTimeout: 20_000,
  },
});

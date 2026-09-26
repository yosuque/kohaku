import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "playground",
    environment: "node",
    // No tests yet (task 1 is the scaffold + Node-dependency spike only) — see the vitest config
    // convention note in AGENTS.md: any workspace directory needs a vitest config or the root config's
    // recursive discovery fails, even before this package has anything to test.
    passWithNoTests: true,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "host",
    environment: "node",
    // Removed once create-host.test.ts / mcp.test.ts land (task 2/3) -- see AGENTS.md's "Adding a new
    // package" pitfall: a workspace directory without a vitest config makes the root config recurse into
    // itself and fail, so this placeholder config must exist from the package's first commit.
    passWithNoTests: true,
  },
});

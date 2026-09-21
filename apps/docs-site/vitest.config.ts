import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "docs-site",
    environment: "node",
    // Removed in Task 2 once the first test file exists (kept here so this commit stays green).
    passWithNoTests: true,
  },
});

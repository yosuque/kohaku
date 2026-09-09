import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "sample-mcp",
    environment: "node",
    passWithNoTests: true,
  },
});

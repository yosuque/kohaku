import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "port-contracts",
    environment: "node",
    passWithNoTests: true,
  },
});

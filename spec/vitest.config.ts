import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "spec-conformance",
    environment: "node",
  },
});

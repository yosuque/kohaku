import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "renderer-core",
    // Only framework-free logic (no DOM dependency), so the node env is sufficient.
    environment: "node",
  },
});

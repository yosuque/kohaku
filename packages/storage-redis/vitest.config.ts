import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "storage-redis",
    environment: "node",
    // A container start (image pull on first run) can take a while.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});

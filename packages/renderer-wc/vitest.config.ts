import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "renderer-wc",
    // jsdom implements Custom Elements v1 + Shadow DOM, so this can run headless.
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    // jsdom setup / teardown can be slow under parallel load; avoid flaking on vitest's default 5000ms.
    testTimeout: 20_000,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "sandbox",
    environment: "jsdom",
    // jsdom setup / teardown (and the dynamic jsdom import in src/smoke) can be slow under parallel load;
    // avoid flaking on vitest's default 5000ms.
    testTimeout: 20_000,
  },
});

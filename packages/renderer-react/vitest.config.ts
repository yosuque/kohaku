import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "renderer-react",
    environment: "jsdom",
    // Required for @testing-library/react's automatic afterEach cleanup
    globals: true,
    // jsdom setup / teardown can be slow under parallel load; avoid flaking on vitest's default 5000ms.
    testTimeout: 20_000,
  },
});

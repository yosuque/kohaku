import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "storage-redis",
    environment: "node",
    // Starts (at most) one Redis container for the whole project run and hands its URL to every test
    // file via provide/inject — see test/global-setup.ts and test/backend.ts.
    globalSetup: ["./test/global-setup.ts"],
    // A container start (image pull on first run) can take a while.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "authz-hmac",
    environment: "node",
  },
});

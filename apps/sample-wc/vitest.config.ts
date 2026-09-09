import { defineConfig } from "vitest/config";

// This is a demo app with no tests, but a workspace directory without a config makes the root config recurse
// into itself and fail, so we place a vitest config with passWithNoTests (a known pitfall documented in AGENTS.md). Parity is guaranteed on the renderer-wc side.
export default defineConfig({
  test: {
    name: "sample-wc",
    passWithNoTests: true,
  },
});

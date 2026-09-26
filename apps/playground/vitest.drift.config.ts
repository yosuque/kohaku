import { defineConfig } from "vitest/config";

/**
 * A separate, explicitly-registered project (the root vitest.config.ts's `projects` array lists this file's
 * path directly, alongside its `"apps/*"` glob entry) — not nested inside vitest.config.ts's own `test`,
 * since Vitest does not flatten a `projects` array defined inside a config that was itself discovered via
 * another project's glob entry (tried; `--project playground-drift` and even `--project playground` both
 * then failed to resolve at all). Run only via `pnpm vitest run --project playground-drift` — see
 * docs/user-guide.md / AGENTS.md's own note on why it is not part of the default `pnpm test`.
 */
export default defineConfig({
  test: {
    name: "playground-drift",
    environment: "node",
    include: ["test/drift/**/*.test.ts"],
  },
});

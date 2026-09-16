import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Load the repo-root .env (Node 22+) before reading KOHAKU_API_URL/PORT below, so ".env" works the same
// as exporting the variable in the shell — either one is fine, per docs/user-guide.md. loadEnvFile does
// not overwrite a variable already present in process.env, so a shell-exported value still wins over the
// file. Guarded by existsSync since .env is optional (.env.example is the checked-in template) and
// loadEnvFile throws on a missing path.
const repoRootEnvFile = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");
if (existsSync(repoRootEnvFile)) {
  process.loadEnvFile?.(repoRootEnvFile);
}

// The proxy target follows KOHAKU_API_URL (or PORT, sample-api's own port override) rather than a hardcoded
// :8787, so "change PORT if it conflicts" (per the user guide) does not silently break every API call by
// leaving the proxy pointed at the old port.
const apiUrl = process.env["KOHAKU_API_URL"] ?? `http://localhost:${process.env["PORT"] ?? 8787}`;

// Zero-React vanilla page (no plugin needed). Runs independently on a separate port from sample-web (:5173).
export default defineConfig({
  server: {
    port: 5174,
    proxy: {
      "/api": apiUrl,
    },
  },
});

import { defineConfig } from "vite";

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

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The proxy target follows KOHAKU_API_URL (or PORT, sample-api's own port override) rather than a hardcoded
// :8787, so "change PORT if it conflicts" (per the user guide) does not silently break every Dashboard API
// call by leaving the proxy pointed at the old port.
const apiUrl = process.env["KOHAKU_API_URL"] ?? `http://localhost:${process.env["PORT"] ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": apiUrl,
    },
  },
});

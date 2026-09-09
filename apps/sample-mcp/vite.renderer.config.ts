import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * Single-file build of the shared renderer (JS/CSS fully inlined).
 * Served as an MCP Apps ui:// resource and runs in the host's sandbox iframe.
 * Self-contained with zero network dependency (works under the strictest CSP).
 */
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "dist",
    rollupOptions: {
      input: "renderer/index.html",
    },
  },
});

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * Single-file build of the core-only shared renderer (JS/CSS fully inlined) that this package ships as
 * `dist/renderer.html` (see `src/index.ts`'s `loadRendererHtml`). Runs in an MCP host's sandboxed iframe;
 * self-contained with zero network dependency (works under the strictest CSP). Mirrors
 * apps/sample-mcp/vite.renderer.config.ts, which builds the same entry point (`bootMcpRenderer`) with a
 * product-specific `registerImpls` baked in instead.
 *
 * `emptyOutDir: false` because the package's `build` script runs `tsc` (emitting `dist/*.js` + `.d.ts` for
 * the `.` / `./boot` exports) before this `vite build` step, into the same `dist/` -- vite's default would
 * otherwise empty that directory and delete tsc's output. This step's own output
 * (`dist/renderer/index.html`) is renamed to the flat `dist/renderer.html` the package.json `build` script
 * expects by a shell step right after this command (`mv` + `rmdir`), since rollup names an HTML entry's
 * output after its input path relative to the project root.
 */
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: {
      input: "renderer/index.html",
    },
  },
});

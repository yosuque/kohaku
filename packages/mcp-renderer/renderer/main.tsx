/**
 * Vite entry point for the core-only renderer build (`pnpm run build`'s `vite build` step, see
 * vite.renderer.config.ts). This is what ships as `dist/renderer.html` -- the `.` entry point's
 * `loadRendererHtml()` reads exactly this file's build output. It boots with no `registerImpls`, so it
 * renders with the core component set only (@kohaku-ui/registry's built-ins); a product wanting its own
 * component implementations baked in instead rebuilds its own entry point against `./boot`'s
 * `bootMcpRenderer` (see apps/sample-mcp/renderer/main.tsx for a worked example).
 */
import { bootMcpRenderer } from "../src/boot/index.js";

await bootMcpRenderer();

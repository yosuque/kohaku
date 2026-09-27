/**
 * Vite entry point for this sample's own renderer build (`pnpm --filter @kohaku-ui-sample/mcp run
 * build:renderer`, see vite.renderer.config.ts). Overlays the sales-domain implementations
 * (sales.kpiCard / sales.calendarHeatmap, etc.) onto the core registry via `registerSalesImpls` -- the same
 * function the Web app's SpecSurface uses (Strategy A: both surfaces render identically). Everything else
 * (the ext-apps bridge, the static snapshot mode, theming, self-recovery) lives in
 * `@kohaku-ui/mcp-renderer/boot`'s `bootMcpRenderer`, shared with the package's own core-only build.
 */
import { bootMcpRenderer } from "@kohaku-ui/mcp-renderer/boot";
import { registerSalesImpls } from "@kohaku-ui-sample/web/renderer-impls";

await bootMcpRenderer({ registerImpls: registerSalesImpls });

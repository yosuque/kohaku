/**
 * Checks the built `dist/renderer.html` (produced by `pnpm --filter @kohaku-ui/mcp-renderer run build`).
 * Skipped when `dist/` has not been built -- packages export `src` directly during development and `dist`
 * is gitignored, so a plain `pnpm test` never builds it; `pnpm build:dist` / `pnpm smoke:pack` do, and this
 * test is meaningful there.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDERER_HTML_PATH = join(HERE, "..", "dist", "renderer.html");
const built = existsSync(RENDERER_HTML_PATH);

describe.skipIf(!built)("built dist/renderer.html", () => {
  const html = built ? readFileSync(RENDERER_HTML_PATH, "utf8") : "";

  it('declares the <meta name="kohaku-renderer" content="core"> marker', () => {
    expect(html).toMatch(/<meta\s+name="kohaku-renderer"\s+content="core"\s*\/?>/);
  });

  it("has the #kohaku-snapshot slot kohaku_render_snapshot fills in", () => {
    expect(html).toContain('<script id="kohaku-snapshot" type="application/json">null</script>');
  });

  it("is fully self-contained (single-file build: no external <script src> or <link href>)", () => {
    expect(html).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(html).not.toMatch(/<link[^>]*\shref=/i);
  });
});

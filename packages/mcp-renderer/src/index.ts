import { readFile } from "node:fs/promises";

/**
 * Loads the pre-built, single-file MCP Apps renderer bundle (core kohaku component set only -- no
 * product-specific implementations). Reads `dist/renderer.html` next to this module: `new
 * URL("../dist/renderer.html", import.meta.url)` resolves to the same package-root-relative path
 * whether this file runs as `src/index.ts` (workspace development) or as the published `dist/index.js`
 * (one level below the package root either way), so the same expression works unbuilt and built.
 *
 * Memoizes the first successful read (the bundle is a few-hundred-KB single-file HTML with inlined JS/CSS,
 * not worth re-reading on every call -- e.g. once per `resources/read ui://kohaku/renderer.html` and once
 * per `${prefix}_render_snapshot`). A failed read is not cached, so a build that completes after the first
 * (failed) call is picked up by the next one.
 *
 * This is the "." entry point and has zero npm dependencies (only `node:fs/promises`, a Node builtin) --
 * a REST-only or non-MCP consumer of `@kohaku-ui/mcp-renderer` never installs anything beyond this
 * package. Building a product-specific renderer (baking in your own component implementations) is the
 * separate `@kohaku-ui/mcp-renderer/boot` entry point, which pulls in React + renderer-react as peers.
 */

let cached: string | undefined;

export async function loadRendererHtml(): Promise<string> {
  if (cached != null) return cached;
  const url = new URL("../dist/renderer.html", import.meta.url);
  let html: string;
  try {
    html = await readFile(url, "utf8");
  } catch (e) {
    throw new Error(
      "@kohaku-ui/mcp-renderer: dist/renderer.html was not found. In this workspace, build it with " +
        "`pnpm --filter @kohaku-ui/mcp-renderer run build`; in an installed copy of the package, the " +
        "prebuilt file ships inside the npm tarball, so a missing file there means a broken/incomplete " +
        "install -- try reinstalling the package.",
      { cause: e },
    );
  }
  cached = html;
  return html;
}

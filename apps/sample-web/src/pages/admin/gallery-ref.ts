/**
 * Extracts the ref argument of the first `window.kohaku.fetchData("...")` (or bare `kohaku.fetchData(...)`)
 * call found in an L2 artifact's HTML source. Used only by GalleryTab's paste box: a real host derives a
 * Spec node's `data.$ref` from the Spec the artifact was generated against, never by scraping the
 * artifact's own source — this is a gallery-only convenience so an arbitrary pasted artifact can be
 * previewed without knowing its ref in advance. The sandbox bridge enforces exact-string-equality between
 * the ref a fetchData call passes and the node's declared $ref (see gallery-showcase.ts's
 * GALLERY_CANNED_REF doc for why a mismatch fails silently), so guessing wrong here just reproduces the
 * same denial this helper exists to avoid. Falls back to `fallback` when no fetchData call is found (e.g.
 * an artifact that never fetches).
 */
export function extractPastedRef(html: string, fallback: string): string {
  const m = /kohaku\s*\.\s*fetchData\s*\(\s*(["'`])([^"'`]+)\1/.exec(html);
  return m?.[2] ?? fallback;
}

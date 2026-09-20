import { collectL2Issues, DEFAULT_KIT_VOCABULARY } from "@kohaku-ui/composer";
import { describe, expect, it } from "vitest";
import { GALLERY_CANNED_REF, GALLERY_SHOWCASE_HTML } from "../src/pages/admin/gallery-showcase.js";

/** Every `class="…"` attribute value's whitespace-separated tokens (set membership, not `\b` substring —
 * `\bk-card\b` would also match inside `k-card-title`, silently tolerating a dropped `class="k-card"`). */
function staticClassTokens(html: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of html.matchAll(/\bclass\s*=\s*"([^"]*)"/g)) {
    for (const token of m[1]!.split(/\s+/)) {
      if (token !== "") tokens.add(token);
    }
  }
  return tokens;
}

describe("gallery showcase artifact", () => {
  it("passes the L2 lint with the kit and token enforcement (it is the kit's living style guide)", () => {
    expect(
      collectL2Issues(GALLERY_SHOWCASE_HTML, { enforceTokenColors: true, kit: DEFAULT_KIT_VOCABULARY }),
    ).toEqual([]);
  });

  it("exercises every component class of the kit at least once", () => {
    const tokens = staticClassTokens(GALLERY_SHOWCASE_HTML);
    for (const cls of Object.keys(DEFAULT_KIT_VOCABULARY.classes)) {
      expect(tokens.has(cls), cls).toBe(true);
    }
  });

  it("fetches exactly the ref GalleryTab declares as the Spec node's data.$ref", () => {
    // The sandbox bridge (packages/sandbox/src/host-bridge.ts) enforces exact-string-equality between a
    // fetchData call's ref and the node's declared $ref; a mismatch is a silent ERR_REF_NOT_ALLOWED denial
    // (the guest still reaches ready() on its own error path). This is the textual half of that guarantee —
    // gallery-showcase-render.test.ts is the behavioral half (it actually runs the script and checks the DOM).
    expect(GALLERY_SHOWCASE_HTML).toContain(`fetchData("${GALLERY_CANNED_REF}")`);
  });
});

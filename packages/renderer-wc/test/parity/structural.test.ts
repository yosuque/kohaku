// Structural parity (the main check): for the golden corpus, React tree ≡ WC tree (semantic DOM equivalence).
// Both renderers consume the same renderer-core pure functions, so the only differences detected here are in markup assembly.

import { afterEach, describe, expect, it } from "vitest";
import { corpusBinding, STRUCTURAL_CORPUS } from "./corpus.js";
import { cleanupPair, renderPair } from "./render-both.js";

const THEME = {
  "color.text": "#111827",
  "color.muted": "#667085",
  "color.positive": "#15803d",
  "color.negative": "#b91c1c",
};

describe("structure parity: React tree ≡ WC tree (semantic DOM equivalence)", () => {
  afterEach(() => cleanupPair());

  for (const [name, spec] of Object.entries(STRUCTURAL_CORPUS)) {
    it(name, async () => {
      const { react, wc } = await renderPair(spec, { binding: corpusBinding, theme: THEME, locale: "ja-JP" });
      expect(wc).toEqual(react);
    });
  }
});

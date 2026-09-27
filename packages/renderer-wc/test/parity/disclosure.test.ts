// AI-generation disclosure parity (design.md #66). Unlike structural.test.ts, this is not a 1:1 DOM-shape
// comparison: React has no host element of its own to mark, so SpecView wraps the tree in an internal
// <div> carrying the disclosure attributes, while <kohaku-surface> puts them on the *host* element itself
// (its shadow root only gets the visible label, in "label" mode). What must match between the two
// renderers is the *semantic* disclosure information -- the derived level/tier/digitalSourceType and the
// localized label text -- not the concrete element each one happens to live on.

import { DEFAULT_MESSAGES } from "@kohaku-ui/renderer-react";
import { afterEach, describe, expect, it } from "vitest";
import { DISCLOSURE_CORPUS } from "./corpus.js";
import { cleanupPair, renderReact, renderWc } from "./render-both.js";

describe("disclosure parity: React's wrapper div ~ WC's host attributes (semantic equivalence)", () => {
  afterEach(() => cleanupPair());

  for (const [name, spec] of Object.entries(DISCLOSURE_CORPUS)) {
    it(`${name}: off (default) adds nothing in either renderer`, async () => {
      const { container } = await renderReact(spec);
      const { surface } = await renderWc(spec);
      expect(container.querySelector("[data-kohaku-disclosure]")).toBeNull();
      expect(surface.hasAttribute("data-kohaku-disclosure")).toBe(false);
      expect(surface.shadowRoot!.querySelector("[data-kohaku-disclosure-label]")).toBeNull();
    });

    it(`${name}: attributes mode agrees on level/tier/digitalSourceType`, async () => {
      const { container } = await renderReact(spec, { disclosure: "attributes" });
      const { surface } = await renderWc(spec, { disclosure: "attributes" });

      const reactWrapper = container.querySelector("[data-kohaku-disclosure]") as HTMLElement;
      expect(reactWrapper).not.toBeNull();
      expect(surface.getAttribute("data-kohaku-disclosure")).toBe(
        reactWrapper.getAttribute("data-kohaku-disclosure"),
      );
      expect(surface.getAttribute("data-kohaku-tier")).toBe(reactWrapper.getAttribute("data-kohaku-tier"));
      expect(surface.getAttribute("data-digital-source-type")).toBe(
        reactWrapper.getAttribute("data-digital-source-type"),
      );
      // "attributes" mode never renders visible text in either renderer.
      expect(container.textContent).not.toContain(DEFAULT_MESSAGES.disclosureAiGenerated);
      expect(container.textContent).not.toContain(DEFAULT_MESSAGES.disclosureAiReviewed);
      expect(surface.shadowRoot!.querySelector("[data-kohaku-disclosure-label]")).toBeNull();
    });

    it(`${name}: label mode agrees on the visible label text`, async () => {
      const { container } = await renderReact(spec, { disclosure: "label" });
      const { surface } = await renderWc(spec, { disclosure: "label" });

      const reactWrapper = container.querySelector("[data-kohaku-disclosure]") as HTMLElement;
      const level = reactWrapper.getAttribute("data-kohaku-disclosure");
      const wcLabel = surface.shadowRoot!.querySelector("[data-kohaku-disclosure-label]");

      if (level === "none") {
        // Nothing to disclose: neither renderer shows a label element/text.
        expect(container.textContent).not.toContain(DEFAULT_MESSAGES.disclosureAiGenerated);
        expect(container.textContent).not.toContain(DEFAULT_MESSAGES.disclosureAiReviewed);
        expect(wcLabel).toBeNull();
      } else {
        expect(wcLabel).not.toBeNull();
        const expectedText =
          level === "ai-generated"
            ? DEFAULT_MESSAGES.disclosureAiGenerated
            : DEFAULT_MESSAGES.disclosureAiReviewed;
        expect(container.textContent).toContain(expectedText);
        expect(wcLabel!.textContent).toBe(expectedText);
      }
    });
  }

  it("WC: setting the disclosure attribute after spec re-applies it without a full tree rebuild", async () => {
    const spec = DISCLOSURE_CORPUS["ai-generated (tier L1)"]!;
    const { surface } = await renderWc(spec);
    expect(surface.hasAttribute("data-kohaku-disclosure")).toBe(false);

    surface.setAttribute("disclosure", "label");
    expect(surface.getAttribute("data-kohaku-disclosure")).toBe("ai-generated");
    expect(surface.shadowRoot!.querySelector("[data-kohaku-disclosure-label]")?.textContent).toBe(
      DEFAULT_MESSAGES.disclosureAiGenerated,
    );

    surface.removeAttribute("disclosure");
    expect(surface.hasAttribute("data-kohaku-disclosure")).toBe(false);
    expect(surface.shadowRoot!.querySelector("[data-kohaku-disclosure-label]")).toBeNull();
  });
});

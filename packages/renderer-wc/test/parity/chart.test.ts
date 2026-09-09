// chart parity: because charts differ in visual representation between React (Recharts SVG) and WC (hand-drawn inline SVG / table fallback),
// pixel/structural matching is not claimed. What is claimed is "semantic equivalence" —
// that figure's role / aria-label and the contents of the visually hidden a11y data table match between the two (handoff ①).

import { parseSpec } from "@kohaku-ui/spec-core";
import { afterEach, describe, expect, it } from "vitest";
import exampleFixture from "../../../../spec/examples/quarterly-sales.spec.json";
import { CHART_CORPUS, corpusBinding } from "./corpus.js";
import { cleanupPair, normalize, renderReact, renderWc } from "./render-both.js";

/** Gets the visually hidden a11y data table under the figure (a table with a caption). */
function a11yTable(figure: Element): HTMLTableElement {
  const tables = [...figure.querySelectorAll("table")] as HTMLTableElement[];
  const withCaption = tables.find((t) => t.caption != null);
  if (withCaption == null) throw new Error("a11y table (a table with a caption) not found");
  return withCaption;
}

describe("chart parity: semantic equivalence (figure role + a11y table contents)", () => {
  afterEach(() => cleanupPair());

  for (const [name, spec] of Object.entries(CHART_CORPUS)) {
    it(`${name}: figure role/aria-label and a11y table match`, async () => {
      const ctx = { binding: corpusBinding };
      const { container } = await renderReact(spec, ctx);
      const { surface } = await renderWc(spec, ctx);
      const reactFigure = container.querySelector('[data-kohaku="chart1"]')!;
      const wcFigure = surface.shadowRoot!.querySelector('[data-kohaku="chart1"]')!;

      // The figure's own semantic attributes (implicit role figure + aria-label + data-kohaku) match.
      expect(wcFigure.tagName.toLowerCase()).toBe("figure");
      expect(reactFigure.tagName.toLowerCase()).toBe("figure");
      expect(wcFigure.getAttribute("aria-label")).toBe(reactFigure.getAttribute("aria-label"));
      expect(wcFigure.getAttribute("data-kohaku")).toBe("chart1");

      // The a11y data table's structure and contents (caption / thead / tbody / cell values) match exactly.
      expect(normalize(a11yTable(wcFigure))).toEqual(normalize(a11yTable(reactFigure)));
    });
  }

  it("canonical example (quarterly-sales) chart1 a11y table matches across both renderers", async () => {
    const spec = parseSpec(exampleFixture);
    const ctx = { binding: corpusBinding };
    const { container } = await renderReact(spec, ctx);
    const { surface } = await renderWc(spec, ctx);
    const reactChart = container.querySelector('[data-kohaku="chart1"]')!;
    const wcChart = surface.shadowRoot!.querySelector('[data-kohaku="chart1"]')!;
    expect(normalize(a11yTable(wcChart))).toEqual(normalize(a11yTable(reactChart)));
  });
});

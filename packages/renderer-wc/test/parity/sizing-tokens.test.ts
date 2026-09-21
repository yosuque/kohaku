// Parity coverage for non-color theme tokens (radius / space / font.size, resolved by renderer-core's
// resolveSizing into SizingTokens and consumed by the presenter style functions). Every existing parity
// spec uses the default theme, and the defaults are identical in light and dark, so a presenter that
// silently dropped its `sizing` argument (falling back to DEFAULT_SIZING) would be invisible to every
// other test in this directory. This file overrides radius.md / space.4 / font.size.md and asserts the
// overridden values actually reach the rendered inline styles of one part per family — an action.button
// (radius), a presentMetric card (padding) and a presentSpreadsheet td (padding) — in both renderers.

import { parseSpec, type UISpec } from "@kohaku-ui/spec-core";
import { afterEach, describe, expect, it } from "vitest";
import { corpusBinding, REF } from "./corpus.js";
import type { SemanticNode } from "./normalize.js";
import { cleanupPair, renderPair } from "./render-both.js";

// radius.md / space.4 / font.size.md are the tokens explicitly asked for (action.button's radius/padding
// and font size, presentMetric's card padding). space.2 / space.3 are added on top of that set because
// spreadsheetTdStyle's padding (packages/renderer-core/src/presenters/spreadsheet.ts) is built from
// `${sizing.space2} ${sizing.space3}` and reads neither radius.md, space.4 nor font.size.md — without
// overriding them too, a spreadsheet td's padding would be indistinguishable from DEFAULT_SIZING and this
// test could not prove the token actually reached the cell.
const SIZING_THEME = {
  "radius.md": "2px",
  "space.2": "5px",
  "space.3": "9px",
  "space.4": "3px",
  "font.size.md": "17px",
};

const SPEC: UISpec = parseSpec({
  kohaku: "0.1",
  intent: { canonical: "parity.sizing", params: {}, hash: "sha256:" + "0".repeat(64) },
  dataVersion: "v1",
  refVersions: { [REF]: "v1" },
  components: [
    { id: "root", type: "layout.stack", props: {}, children: ["btn", "metric", "sheet"] },
    { id: "btn", type: "action.button", props: { label: "Go", variant: "primary" } },
    {
      id: "metric",
      type: "presentMetric",
      props: { label: "Revenue", valueColumn: "revenue", format: "currency", currency: "JPY" },
      data: { $ref: REF },
    },
    { id: "sheet", type: "presentSpreadsheet", props: {}, data: { $ref: REF } },
  ],
  events: [],
  provenance: { tier: "L0", composedBy: "parity", cache: "hit" },
});

/** Depth-first search for the first node matching `pred` (both SemanticNode and its element children). */
function find(node: SemanticNode, pred: (n: SemanticNode) => boolean): SemanticNode | undefined {
  if (pred(node)) return node;
  for (const child of node.children) {
    if ("text" in child) continue;
    const found = find(child, pred);
    if (found != null) return found;
  }
  return undefined;
}

describe("sizing-token parity: non-color tokens reach the rendered inline styles of both renderers", () => {
  afterEach(() => cleanupPair());

  it("action.button radius, presentMetric padding and spreadsheet td padding all reflect the overridden theme", async () => {
    const { react, wc } = await renderPair(SPEC, { binding: corpusBinding, theme: SIZING_THEME });

    // (a) React ⇄ WC still match structurally under a non-default sizing theme.
    expect(wc).toEqual(react);

    // (b) the overridden values actually appear in the rendered inline styles — one part per family.
    for (const [label, root] of [
      ["react", react],
      ["wc", wc],
    ] as const) {
      const button = find(root, (n) => n.tag === "button" && n.attrs["data-kohaku"] === "btn");
      expect(button, `${label}: action.button`).toBeDefined();
      expect(button!.style["border-radius"], `${label}: action.button borderRadius`).toBe("2px");
      expect(button!.style["font-size"], `${label}: action.button fontSize`).toBe("17px");

      const metric = find(root, (n) => n.attrs["data-kohaku"] === "metric");
      expect(metric, `${label}: presentMetric`).toBeDefined();
      expect(metric!.style["padding"], `${label}: presentMetric padding`).toBe("3px");

      const td = find(root, (n) => n.tag === "td");
      expect(td, `${label}: spreadsheet td`).toBeDefined();
      expect(td!.style["padding"], `${label}: spreadsheet td padding`).toBe("5px 9px");
    }
  });
});

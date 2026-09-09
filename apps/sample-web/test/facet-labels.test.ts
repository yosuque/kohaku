import { describe, expect, it } from "vitest";
import facetViewsData from "../src/generated/facet-views.json";
import { facetLabel } from "../src/pages/facet-views.js";

interface Labeled {
  label: string;
  labels?: Record<string, string>;
}
interface ViewJson extends Labeled {
  intent: string;
  facets: (Labeled & {
    key: string;
    options: Labeled[];
    allowEmpty?: string;
    allowEmptyLabels?: Record<string, string>;
  })[];
}

const views = (facetViewsData as { views: ViewJson[] }).views;

// Guards against forgetting `labels:` overlays in sample-api's catalog.ts / vocab.ts — the type
// system cannot enforce that every EN label got a JA counterpart in the emitted JSON.
describe("generated facet-views.json JA coverage", () => {
  it("has views", () => {
    expect(views.length).toBeGreaterThan(0);
  });

  it("every view label carries a ja overlay", () => {
    for (const view of views) {
      expect(view.labels?.["ja"], `view ${view.intent} is missing a ja label`).toBeTruthy();
    }
  });

  it("every facet label and allowEmpty carries a ja overlay", () => {
    for (const view of views) {
      for (const facet of view.facets) {
        expect(facet.labels?.["ja"], `${view.intent}.${facet.key} is missing a ja label`).toBeTruthy();
        if (facet.allowEmpty != null) {
          expect(
            facet.allowEmptyLabels?.["ja"],
            `${view.intent}.${facet.key} allowEmpty is missing a ja overlay`,
          ).toBeTruthy();
        }
      }
    }
  });

  it("options carry ja overlays except language-neutral labels (Q1-Q4)", () => {
    for (const view of views) {
      for (const facet of view.facets) {
        for (const opt of facet.options) {
          // Q1..Q4 read the same in both languages — no overlay by design.
          if (/^Q[1-4]$/.test(opt.label)) continue;
          expect(
            opt.labels?.["ja"],
            `${view.intent}.${facet.key} option "${opt.label}" is missing a ja overlay`,
          ).toBeTruthy();
        }
      }
    }
  });
});

describe("facetLabel", () => {
  it("picks the overlay for ja and falls back to the canonical label", () => {
    const entry = { label: "Region", labels: { ja: "地域" } };
    expect(facetLabel(entry, "ja")).toBe("地域");
    expect(facetLabel(entry, "en")).toBe("Region");
    expect(facetLabel({ label: "Q1" }, "ja")).toBe("Q1");
  });
});

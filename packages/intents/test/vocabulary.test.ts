import { describe, expect, it } from "vitest";
import { defineVocabulary } from "../src/vocabulary.js";

const region = defineVocabulary("region", {
  japan: "Japan",
  north_america: "North America",
  europe: "Europe",
  apac: "APAC",
});

describe("defineVocabulary", () => {
  it("values / labels preserve insertion order", () => {
    expect(region.values).toEqual(["japan", "north_america", "europe", "apac"]);
    expect(region.labels).toEqual({
      japan: "Japan",
      north_america: "North America",
      europe: "Europe",
      apac: "APAC",
    });
  });

  it("enum() returns a Zod enum that validates the value set", () => {
    const e = region.enum();
    expect(e.safeParse("japan").success).toBe(true);
    expect(e.safeParse("mars").success).toBe(false);
  });

  it("options() returns value + label in insertion order (for GUI facets)", () => {
    expect(region.options()).toEqual([
      { value: "japan", label: "Japan" },
      { value: "north_america", label: "North America" },
      { value: "europe", label: "Europe" },
      { value: "apac", label: "APAC" },
    ]);
  });

  it("label() returns the localized name and returns unknown values as-is (localizing cell values)", () => {
    expect(region.label("japan")).toBe("Japan");
    expect(region.label("unknown")).toBe("unknown");
  });

  it("reverseLabel() reverse-maps a localized name to a code; unknown labels are undefined (for drilldown)", () => {
    expect(region.reverseLabel("Japan")).toBe("japan");
    expect(region.reverseLabel("APAC")).toBe("apac");
    // The code itself (not a label) and unknown labels are undefined.
    expect(region.reverseLabel("japan")).toBeUndefined();
    expect(region.reverseLabel("Mars")).toBeUndefined();
  });

  it("bindValues() returns a copy of values (for A1 data.bind values)", () => {
    const values = region.bindValues();
    expect(values).toEqual(["japan", "north_america", "europe", "apac"]);
    // Must be a copy (does not mutate the internal array).
    values.push("mars");
    expect(region.values).toEqual(["japan", "north_america", "europe", "apac"]);
  });

  it("empty entries is an error", () => {
    expect(() => defineVocabulary("empty", {})).toThrow();
  });
});

describe("defineVocabulary (locale overlays)", () => {
  const bilingual = defineVocabulary("region", {
    japan: { en: "Japan", ja: "日本" },
    north_america: { en: "North America", ja: "北米" },
    // A plain-string entry may coexist with map entries (canonical-only, no overlay).
    europe: "Europe",
  });

  it("labels stays the canonical (English) map", () => {
    expect(bilingual.labels).toEqual({
      japan: "Japan",
      north_america: "North America",
      europe: "Europe",
    });
  });

  it("label(value, locale) picks the overlay and falls back to canonical, then the raw value", () => {
    expect(bilingual.label("japan", "ja")).toBe("日本");
    expect(bilingual.label("japan", "en")).toBe("Japan");
    expect(bilingual.label("japan")).toBe("Japan");
    // Overlay missing for that locale → canonical.
    expect(bilingual.label("europe", "ja")).toBe("Europe");
    expect(bilingual.label("japan", "fr")).toBe("Japan");
    // Unknown value → raw value regardless of locale.
    expect(bilingual.label("mars", "ja")).toBe("mars");
  });

  it("options() carries the overlay map only for entries that declared one", () => {
    expect(bilingual.options()).toEqual([
      { value: "japan", label: "Japan", labels: { ja: "日本" } },
      { value: "north_america", label: "North America", labels: { ja: "北米" } },
      { value: "europe", label: "Europe" },
    ]);
  });

  it("reverseLabel() resolves labels of every locale to the code (drilldown from JA cells)", () => {
    expect(bilingual.reverseLabel("Japan")).toBe("japan");
    expect(bilingual.reverseLabel("日本")).toBe("japan");
    expect(bilingual.reverseLabel("北米")).toBe("north_america");
    expect(bilingual.reverseLabel("Mars")).toBeUndefined();
  });

  it("duplicate labels across locales resolve first-wins in insertion order", () => {
    const v = defineVocabulary("dup", {
      a: { en: "Same", ja: "同じ" },
      b: { en: "Other", ja: "Same" },
    });
    expect(v.reverseLabel("Same")).toBe("a");
    expect(v.reverseLabel("同じ")).toBe("a");
  });
});

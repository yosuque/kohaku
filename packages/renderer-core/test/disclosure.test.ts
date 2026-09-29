import type { Provenance } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type DisclosureLevel, deriveDisclosure, disclosureDomAttributes } from "../src/disclosure.js";

function provenance(partial: Partial<Provenance>): Provenance {
  return { tier: "L0", composedBy: "composer@0.1.0", cache: "miss", ...partial };
}

const TIERS = ["L0", "L1", "L2"] as const;
const CACHES = ["hit", "miss", "bypass", "fixated"] as const;
const FALLBACK_TRACE = { from: "sandbox1:sandbox.html", reason: "capability negotiation" };

// "absent" = no fallback; "unspecified" = a fallback without a `kind` (records written before the field existed).
const FALLBACKS = ["absent", "generation", "negotiation", "unspecified"] as const;
type FallbackVariant = (typeof FALLBACKS)[number];

function fallbackFor(variant: FallbackVariant): Pick<Provenance, "fallback"> {
  switch (variant) {
    case "absent":
      return {};
    case "unspecified":
      return { fallback: FALLBACK_TRACE };
    default:
      return { fallback: { ...FALLBACK_TRACE, kind: variant } };
  }
}

describe("deriveDisclosure (design.md #66)", () => {
  // The full tier x cache x fallback-kind cross product (3 x 4 x 4 = 48 cases), each asserted
  // against the exact rule from disclosure.ts's own doc comment, so a future edit to that rule cannot
  // silently narrow or widen a case without this table catching it.
  const table: {
    tier: Provenance["tier"];
    cache: Provenance["cache"];
    fallback: FallbackVariant;
    expected: DisclosureLevel;
  }[] = TIERS.flatMap((tier) =>
    CACHES.flatMap((cache) =>
      FALLBACKS.map((fallback) => ({
        tier,
        cache,
        fallback,
        // Only a "negotiation" fallback is transparent: it demotes a part of a Spec that is still model output.
        expected: (fallback === "generation" || fallback === "unspecified"
          ? "none"
          : tier === "L1" || tier === "L2"
            ? "ai-generated"
            : tier === "L0" && cache === "fixated"
              ? "ai-assisted-reviewed"
              : "none") as DisclosureLevel,
      })),
    ),
  );

  it.each(table)(
    "tier=$tier cache=$cache fallback=$fallback -> $expected",
    ({ tier, cache, fallback, expected }) => {
      const p = provenance({ tier, cache, ...fallbackFor(fallback) });
      expect(deriveDisclosure(p).level).toBe(expected);
    },
  );

  it("has exactly 48 cases in the table (3 tiers x 4 caches x 4 fallback variants)", () => {
    expect(table).toHaveLength(48);
  });

  it("sets digitalSourceType to trainedAlgorithmicMedia for ai-generated", () => {
    const d = deriveDisclosure(provenance({ tier: "L1", cache: "miss" }));
    expect(d).toEqual({ level: "ai-generated", tier: "L1", digitalSourceType: "trainedAlgorithmicMedia" });
  });

  it("sets digitalSourceType to compositeWithTrainedAlgorithmicMedia for ai-assisted-reviewed", () => {
    const d = deriveDisclosure(provenance({ tier: "L0", cache: "fixated" }));
    expect(d).toEqual({
      level: "ai-assisted-reviewed",
      tier: "L0",
      digitalSourceType: "compositeWithTrainedAlgorithmicMedia",
    });
  });

  it('omits digitalSourceType entirely for none (no IPTC term for "not AI")', () => {
    const d = deriveDisclosure(provenance({ tier: "L0", cache: "miss" }));
    expect(d).toEqual({ level: "none", tier: "L0" });
    expect(d).not.toHaveProperty("digitalSourceType");
  });

  it("a generation fallback overrides an L1/L2 tier to none, not ai-generated", () => {
    const d = deriveDisclosure(
      provenance({ tier: "L2", cache: "hit", fallback: { ...FALLBACK_TRACE, kind: "generation" } }),
    );
    expect(d.level).toBe("none");
  });

  it("a negotiation fallback keeps an L1/L2 Spec disclosed as ai-generated", () => {
    const d = deriveDisclosure(
      provenance({ tier: "L2", cache: "hit", fallback: { ...FALLBACK_TRACE, kind: "negotiation" } }),
    );
    expect(d).toEqual({ level: "ai-generated", tier: "L2", digitalSourceType: "trainedAlgorithmicMedia" });
  });
});

describe("disclosureDomAttributes", () => {
  it("builds the data-* attribute record for ai-generated", () => {
    const attrs = disclosureDomAttributes(deriveDisclosure(provenance({ tier: "L1", cache: "miss" })));
    expect(attrs).toEqual({
      "data-kohaku-disclosure": "ai-generated",
      "data-kohaku-tier": "L1",
      "data-digital-source-type": "trainedAlgorithmicMedia",
    });
  });

  it("omits data-digital-source-type for none", () => {
    const attrs = disclosureDomAttributes(deriveDisclosure(provenance({ tier: "L0", cache: "miss" })));
    expect(attrs).toEqual({ "data-kohaku-disclosure": "none", "data-kohaku-tier": "L0" });
    expect(attrs).not.toHaveProperty("data-digital-source-type");
  });
});

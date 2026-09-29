import type { Provenance } from "@kohaku-ui/spec-core";

/**
 * AI-generation disclosure (design.md #66). Deliberately derived on the render side from
 * `spec.provenance` rather than carried on the wire: SPEC-DISC-001 (spec/SPEC.md §7.1) requires the
 * Spec itself to never encode disclosure, so a host cannot forget to strip it and a renderer cannot
 * trust a stale/forged value baked into the payload -- the same tier/cache fields lineage and `kohaku
 * explain` already read are the single source of truth.
 *
 * Rule (design.md #66):
 * - `provenance.fallback` with `kind` `"generation"` (or no `kind`) -> `"none"`. That fallback is the
 *   deterministic markdown the composer serves once L1/L2 generation is exhausted, not model output,
 *   regardless of the tier it is attached to.
 * - `provenance.fallback` with `kind` `"negotiation"` does not affect the result: capability
 *   negotiation demotes individual parts of a Spec that was still model-generated, so the level is
 *   derived from the tier and cache exactly as if no fallback were present.
 * - tier `"L1"` or `"L2"` -> `"ai-generated"`.
 * - tier `"L0"` and `cache === "fixated"` -> `"ai-assisted-reviewed"` (a human reviewed and fixated a
 *   once-generated Spec; L0 serves the pinned structure from then on).
 * - otherwise (L0 with no model ever involved, or any other cache state) -> `"none"`.
 */
export type DisclosureLevel = "ai-generated" | "ai-assisted-reviewed" | "none";

/**
 * IPTC's Digital Source Type vocabulary (https://cv.iptc.org/newscodes/digitalsourcetype/), the
 * machine-readable term set `data-digital-source-type` uses. Only the two terms this renderer ever
 * needs are declared here; `"none"` has no IPTC term (the attribute is simply omitted).
 */
export type DigitalSourceType = "trainedAlgorithmicMedia" | "compositeWithTrainedAlgorithmicMedia";

export interface Disclosure {
  level: DisclosureLevel;
  tier: Provenance["tier"];
  /** Present only when `level !== "none"` (IPTC has no term for "not AI-involved"). */
  digitalSourceType?: DigitalSourceType;
}

/** Derives the disclosure level (and its IPTC digital-source-type term, when applicable) from a Spec's provenance. */
export function deriveDisclosure(provenance: Provenance): Disclosure {
  const level: DisclosureLevel =
    provenance.fallback != null && provenance.fallback.kind !== "negotiation"
      ? "none"
      : provenance.tier === "L1" || provenance.tier === "L2"
        ? "ai-generated"
        : provenance.tier === "L0" && provenance.cache === "fixated"
          ? "ai-assisted-reviewed"
          : "none";

  const digitalSourceType: DigitalSourceType | undefined =
    level === "ai-generated"
      ? "trainedAlgorithmicMedia"
      : level === "ai-assisted-reviewed"
        ? "compositeWithTrainedAlgorithmicMedia"
        : undefined;

  return { level, tier: provenance.tier, ...(digitalSourceType != null ? { digitalSourceType } : {}) };
}

/**
 * The `data-*` attributes a renderer sets on the disclosure wrapper it mounts (see renderer-react's
 * `KohakuDisclosureLabel` / renderer-wc's `<kohaku-surface disclosure>`). Kept as plain string values
 * (not a DOM API) so both renderers can apply them their own way (React props vs.
 * `element.setAttribute`).
 */
export interface DisclosureDomAttributes {
  "data-kohaku-disclosure": DisclosureLevel;
  "data-kohaku-tier": Provenance["tier"];
  "data-digital-source-type"?: DigitalSourceType;
}

/** Builds the `data-*` attribute record for a `Disclosure` (see `DisclosureDomAttributes`). */
export function disclosureDomAttributes(disclosure: Disclosure): DisclosureDomAttributes {
  return {
    "data-kohaku-disclosure": disclosure.level,
    "data-kohaku-tier": disclosure.tier,
    ...(disclosure.digitalSourceType != null
      ? { "data-digital-source-type": disclosure.digitalSourceType }
      : {}),
  };
}

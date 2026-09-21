import { z } from "zod";

/**
 * Provenance information directly tied to View Lineage.
 * Records the tier, the composing agent, and cache hits, making "why this screen was displayed"
 * auditable.
 */
export const ProvenanceSchema = z.object({
  tier: z.enum(["L0", "L1", "L2"]),
  composedBy: z.string(),
  model: z.string().optional(),
  cache: z.enum(["hit", "miss", "bypass", "fixated"]),
  /** The trace of a component demoted by capability negotiation or repair. */
  fallback: z
    .object({
      from: z.string(),
      reason: z.string(),
      /**
       * The kind of demotion (observability).
       * - `generation`: the deterministic fallback when L1/L2 generation is exhausted (turned into
       *   presentMarkdown)
       * - `negotiation`: component demotion due to surface capability negotiation
       */
      kind: z.enum(["generation", "negotiation"]).optional(),
    })
    .optional(),
  composedAt: z.iso.datetime().optional(),
  /** The host's generator identity in effect at composition time (prompt revision / model / design-system generation). */
  generatorVersion: z.string().optional(),
  /**
   * The design kit the generated markup was written against (component's DesignSystemGuide.kit, if set).
   * Lets a render-side surface compare its own kit identity against this and detect a version mismatch
   * instead of rendering unstyled markup silently (spec/SPEC.md §2.1, SPEC-KIT-001).
   */
  kit: z.object({ id: z.string(), version: z.string() }).optional(),
});

export type Provenance = z.infer<typeof ProvenanceSchema>;

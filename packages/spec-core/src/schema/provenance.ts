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
});

export type Provenance = z.infer<typeof ProvenanceSchema>;

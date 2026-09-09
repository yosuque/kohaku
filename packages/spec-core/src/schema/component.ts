import { z } from "zod";
import { JsonValueSchema } from "./json.js";
import { StateKeySchema, VisibleWhenSchema } from "./state.js";

export const ComponentIdSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);

/**
 * A single parameter of the binding sidecar for two-way binding (kohaku >= 0.2 [Draft]).
 * Replaces the corresponding $ref parameter with the $state key's value to form the effective ref.
 * - $state: the client-local state key to reference (must have an initial value in spec.state —
 *   BIND_STATE_UNKNOWN).
 * - values: the authorized value domain (discrete strings). The **sole source of truth** for capability
 *   variant enumeration at compose time, independent of the control's options (keeping the design where
 *   data-binding does not know about registry).
 * strict: rejects unknown-key contamination (the same decision as DataRefSchema).
 */
export const BindParamSchema = z
  .object({
    $state: StateKeySchema,
    values: z.array(z.string()).min(1),
  })
  .strict();

/**
 * Data is reference-passing only. Bulk data is never placed on the Spec (so bulk data never travels
 * through the model's context).
 * strict: rejects, rather than strips, keys other than $ref / bind (bulk contamination such as rows /
 * columns) — silently stripping would let SPEC-DATA-001 (no embedded bulk data) slip past the check.
 */
export const DataRefSchema = z
  .object({
    // The trailing $ and [^#] forbid a # fragment, matching the grammar of data-binding's parseQueryRef.
    // A loose .+ would create an asymmetry where a $ref that passed spec-core fails later in
    // parseQueryRef. $ref is the concrete canonical URI (the initial variant), with bound parameters
    // filled by their initial $state values.
    $ref: z.string().regex(/^query:\/\/[a-z0-9_-]+\/[^#]+$/),
    /**
     * Two-way binding (kohaku >= 0.2 [Draft]). param name → binding definition.
     * Structural consistency (the three-way match of initial values, the reserved namespace, the variant
     * limit) is handled by validate.ts's BIND_* checks.
     */
    bind: z.record(z.string().min(1), BindParamSchema).optional(),
  })
  .strict();

/**
 * The artifact of an L2 (free-generation) component. Exactly one of inline or uri.
 * sha256 is used for integrity verification before mount.
 * strict: rejects, rather than strips, unknown-key contamination other than { inline, uri, sha256 } —
 * applying the same decision as DataRefSchema (silent stripping slips past the SPEC check) to L2
 * artifact references too.
 */
export const SandboxArtifactRefSchema = z
  .object({
    inline: z.string().optional(),
    uri: z.string().optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .refine((a) => (a.inline != null) !== (a.uri != null), {
    message: "artifact must have exactly one of inline / uri",
  });

/** The reserved component type representing L2 free-generation HTML. */
export const SANDBOX_HTML_TYPE = "sandbox.html";

/**
 * A component node as a flat list + ID references.
 * Easy for the LLM to generate and edit, and well-suited to diff updates and streaming.
 */
export const ComponentNodeSchema = z.object({
  id: ComponentIdSchema,
  type: z.string().min(1),
  /** Pins the catalog version composer resolved. */
  version: z.string().optional(),
  props: z.record(z.string(), JsonValueSchema).default({}),
  children: z.array(ComponentIdSchema).optional(),
  data: DataRefSchema.optional(),
  artifact: SandboxArtifactRefSchema.optional(),
  /**
   * The conditional-display predicate (kohaku >= 0.2). If false, the Renderer does not render this node
   * or its subtree. The predicate's referenced keys must have an initial value in spec.state
   * (STATE_REF_UNKNOWN).
   */
  visibleWhen: VisibleWhenSchema.optional(),
});

export type ComponentNode = z.infer<typeof ComponentNodeSchema>;
export type DataRef = z.infer<typeof DataRefSchema>;
export type BindParam = z.infer<typeof BindParamSchema>;
export type SandboxArtifactRef = z.infer<typeof SandboxArtifactRefSchema>;

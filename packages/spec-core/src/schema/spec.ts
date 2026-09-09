import { z } from "zod";
import { ComponentNodeSchema } from "./component.js";
import { EventBindingSchema } from "./events.js";
import { IntentSchema } from "./intent.js";
import { JsonValueSchema } from "./json.js";
import { ProvenanceSchema } from "./provenance.js";
import { StateKeySchema } from "./state.js";

/**
 * The protocol version to emit. Newly composed Specs declare this version.
 *
 * Adopts the versioning strategy "emit 0.2, accept {0.1, 0.2}".
 * - Rejected: keeping the literal "0.1" and adding state, etc., as optional — an old implementation
 *   would silently drop a state-bearing Spec via zod strip, degrading into missing functionality
 *   silently (undetectable).
 * - Also rejected: accepting only "0.2" — every existing fixation pinnedSpec ("0.1") would die on all
 *   paths.
 * New features (state / visibleWhen / state.set) are allowed only on 0.2, and placing them on 0.1 is
 * rejected with VERSION_FEATURE_MISMATCH (validate.ts's feature gate).
 */
export const SPEC_VERSION = "0.2" as const;

/** The set of accepted protocol versions. Existing 0.1 Specs remain valid and continue to be served. */
export const ACCEPTED_SPEC_VERSIONS = ["0.1", "0.2"] as const;

/**
 * The UI Spec envelope.
 * It holds no theme information (tokens are resolved on the Renderer side).
 * The LLM generates only components / events; the envelope is filled in by code.
 */
export const UISpecSchema = z.object({
  kohaku: z.enum(ACCEPTED_SPEC_VERSIONS),
  intent: IntentSchema,
  dataVersion: z.string().min(1),
  /**
   * $ref URI → the dataVersion of that reference alone. Used for component-side version matching when
   * dataVersion is `multi:`. Even for a Spec whose $refs disagree on version, the Renderer can resolve
   * and match against the per-reference single version.
   */
  refVersions: z.record(z.string(), z.string()).optional(),
  /**
   * Initial values of client-local state (kohaku >= 0.2). key → JSON value.
   * Closed within the Renderer and not sent to the server. Keys referenced by visibleWhen must have an
   * initial value (enforced by STATE_REF_UNKNOWN — guaranteeing determinism of the initial render).
   */
  state: z.record(StateKeySchema, JsonValueSchema).optional(),
  components: z.array(ComponentNodeSchema).min(1),
  events: z.array(EventBindingSchema).default([]),
  provenance: ProvenanceSchema,
});

export type UISpec = z.infer<typeof UISpecSchema>;

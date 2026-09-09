import { z } from "zod";
import { ComponentIdSchema, ComponentNodeSchema } from "./component.js";
import { EventBindingSchema } from "./events.js";
import { IntentHashSchema, IntentSchema } from "./intent.js";
import { JsonValueSchema } from "./json.js";
import { ProvenanceSchema } from "./provenance.js";
import { ACCEPTED_SPEC_VERSIONS } from "./spec.js";
import { StateKeySchema } from "./state.js";

/**
 * A per-component semantic patch (ID-level upsert/remove, not JSON Patch).
 * A form optimized for the flat-list + ID-reference Spec design and for the interaction loop's
 * "Intent diff → Spec diff update" and streaming (skeleton → finalized form).
 *
 * This schema validates only the wire-shape types and value ranges (the baseIntentHash format, the ban
 * on bulk contamination in data $ref, etc.). It does not structurally validate the patch on its own
 * (ID uniqueness, root required, acyclicity) — validateSpecStructure runs inside applyPatch after
 * application, so no second source of truth is created.
 */
export const SpecPatchSchema = z.object({
  // The same `sha256:<hex64>` format as the Intent hash. Whether it matches the target Spec's
  // intent.hash is decided by applyPatch.
  baseIntentHash: IntentHashSchema,
  /**
   * Protocol version change (e.g. a 0.1 Spec promoted to 0.2 by a patch that also introduces `state`).
   * Omitted = no version change (applyPatch keeps the target Spec's current `kohaku`). Present only when
   * diffSpec observes prev.kohaku !== next.kohaku (SPEC-PATCH-001's round-trip MUST otherwise loses the
   * version change and, if `state` is added in the same patch, spuriously fails VERSION_FEATURE_MISMATCH
   * against the stale prior version).
   */
  kohaku: z.enum(ACCEPTED_SPEC_VERSIONS).optional(),
  intent: IntentSchema.optional(),
  upsert: z.array(ComponentNodeSchema).optional(),
  remove: z.array(ComponentIdSchema).optional(),
  events: z.array(EventBindingSchema).optional(),
  dataVersion: z.string().min(1).optional(),
  /** Full replace of refVersions. null represents removal of refVersions (the next Spec has no refVersions). */
  refVersions: z.record(z.string(), z.string()).nullable().optional(),
  /** Full replace of state (same shape as refVersions). null represents removal of state (kohaku >= 0.2). */
  state: z.record(StateKeySchema, JsonValueSchema).nullable().optional(),
  provenance: ProvenanceSchema.optional(),
});

export type SpecPatch = z.infer<typeof SpecPatchSchema>;

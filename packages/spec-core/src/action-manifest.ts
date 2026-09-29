import type { ActionTier } from "./action-params.js";
import type { JsonValue } from "./schema/json.js";

/** One entry of an `ActionManifest` (design.md #64: the wire shape of `actions[name]`). */
export interface ActionManifestEntry {
  tier: ActionTier;
  /**
   * The action's raw params schema (the same value `OperationDescriptor.paramsSchema` declared), when
   * present. Kept as the wire-shaped `JsonValue` (not the stricter `ActionParamsSchema`) since a consumer
   * receives it over the wire from the host -- `preflightAction` casts it before validating.
   */
  paramsSchema?: JsonValue;
  confirmMessage?: string;
}

/**
 * `{ [actionName]: ActionManifestEntry }`, keyed by exactly the write actions the Spec declares that the
 * host also recognizes as a `DomainPort` operation (SPEC §5 A1, `collectWriteActions`). Carried alongside a
 * compose response, outside the Spec itself (design.md #64: next to the capability), so it never affects
 * `specHash` / the cache key. The wire contract shared by host-core (which builds it), the client SDK and
 * renderer-core (which consume it).
 */
export type ActionManifest = Record<string, ActionManifestEntry>;

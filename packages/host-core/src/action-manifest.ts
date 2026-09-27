import type { ActionTier, JsonValue, UISpec } from "@kohaku-ui/spec-core";
import { collectWriteActions } from "@kohaku-ui/spec-core";
import type { OperationIndexEntry } from "./operation-index.js";

/** One entry of an `ActionManifest` (design.md #64: the wire shape of `actions[name]`). */
export interface ActionManifestEntry {
  tier: ActionTier;
  /** The action's raw params schema (the same value `OperationDescriptor.paramsSchema` declared), when present. */
  paramsSchema?: JsonValue;
  confirmMessage?: string;
}

/**
 * `{ [actionName]: ActionManifestEntry }`, keyed by exactly the write actions the Spec declares
 * (`collectWriteActions`, SPEC §5 A1) — the same set a capability's write scopes are issued for. Carried
 * alongside a compose response, not inside the `UISpec` itself (design.md #64: an Action manifest lives
 * outside the Spec, next to the capability), so it never affects `specHash` / the cache key.
 */
export type ActionManifest = Record<string, ActionManifestEntry>;

/**
 * Builds the `ActionManifest` for `spec`, given the domain's `OperationIndex` (already resolved via
 * `createOperationIndex`). An action the Spec declares but that is not a real `DomainPort` operation is
 * silently omitted (the same fail-open drop `filterAllowedScopes`/`WriteScopeDroppedError` already apply
 * to capability issuance for the same reason: a hallucinated/injected `action.invoke` action name must
 * not surface as if it were a governed, known action).
 *
 * Returns `undefined` (never an empty object) when the Spec declares no write actions, or when every
 * declared action was dropped -- so a host can spread `...( { actions } )`-style onto a response object
 * without a `{}` noise field on the common case (a read-only Spec) while still keeping this purely
 * additive to the wire shape.
 */
export function buildActionManifest(
  spec: UISpec,
  index: ReadonlyMap<string, OperationIndexEntry>,
): ActionManifest | undefined {
  const actions = collectWriteActions(spec);
  if (actions.length === 0) return undefined;

  const manifest: ActionManifest = {};
  for (const action of actions) {
    const entry = index.get(action);
    if (entry == null) continue;
    manifest[action] = buildManifestEntry(entry);
  }
  return Object.keys(manifest).length > 0 ? manifest : undefined;
}

function buildManifestEntry(entry: OperationIndexEntry): ActionManifestEntry {
  const result: ActionManifestEntry = { tier: entry.descriptor.tier ?? "auto" };
  if (entry.paramsSchema != null) result.paramsSchema = entry.paramsSchema as unknown as JsonValue;
  if (entry.descriptor.confirmMessage != null) result.confirmMessage = entry.descriptor.confirmMessage;
  return result;
}

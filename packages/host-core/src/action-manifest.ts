import type { ActionManifest, ActionManifestEntry, JsonValue, UISpec } from "@kohaku-ui/spec-core";
import { collectWriteActions } from "@kohaku-ui/spec-core";
import type { OperationIndexEntry } from "./operation-index.js";

// The wire types live in spec-core (shared with the client SDK and renderer-core); re-exported so existing
// `@kohaku-ui/host-core` import sites keep working.
export type { ActionManifest, ActionManifestEntry };

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
    // A declared operation whose paramsSchema failed validation is omitted too: it cannot be invoked.
    if (entry == null || entry.schemaError != null) continue;
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

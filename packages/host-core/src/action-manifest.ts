import type { ActionManifest, ActionManifestEntry, JsonValue, UISpec } from "@kohaku-ui/spec-core";
import { collectWriteActions } from "@kohaku-ui/spec-core";
import type { OperationIndex, OperationIndexEntry } from "./operation-index.js";

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

/**
 * The fail-open `buildActionManifest` both host profiles call when delivering a composed Spec (REST's compose
 * routes, the MCP profile's compose tool): awaits the host's `OperationIndex`, builds the manifest, and on ANY
 * throw -- the index rejecting (`listOperations()` itself failing) or the build throwing -- reports the error
 * through `report` and resolves to `undefined` ("no manifest this time") instead of failing the whole
 * delivery. The same fail-open posture `issueSpecCapabilitySafely` takes for capability issuance under the
 * identical failure.
 *
 * Order-neutral: the host decides where in its own delivery sequence to call this, and supplies the
 * `report` callback carrying its own endpoint name. Contract: `report` must not reject -- same convention as
 * `issueSpecCapabilitySafely`'s `report`.
 */
export async function buildActionManifestSafely(
  operationIndex: OperationIndex,
  spec: UISpec,
  report: (error: unknown) => void | Promise<void>,
): Promise<ActionManifest | undefined> {
  try {
    const index = await operationIndex();
    return buildActionManifest(spec, index);
  } catch (e) {
    await report(e);
    return undefined;
  }
}

function buildManifestEntry(entry: OperationIndexEntry): ActionManifestEntry {
  const result: ActionManifestEntry = { tier: entry.descriptor.tier ?? "auto" };
  if (entry.paramsSchema != null) result.paramsSchema = entry.paramsSchema as unknown as JsonValue;
  if (entry.descriptor.confirmMessage != null) result.confirmMessage = entry.descriptor.confirmMessage;
  return result;
}

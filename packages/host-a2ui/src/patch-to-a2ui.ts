import type { ComponentNode, SpecPatch, UISpec } from "@kohaku-ui/spec-core";
import { applyEventBindings, projectNode, surfaceIdFromIntentHash } from "./to-a2ui.js";
import {
  A2UI_V1_VERSION,
  A2UI_VERSION,
  type A2uiComponent,
  type A2uiConversion,
  type A2uiMessage,
  type A2uiTarget,
  type KohakuSidecar,
} from "./types.js";

/** Options for {@link patchToA2ui}. */
export interface PatchToA2uiOptions {
  /** Output wire target. Defaults to `"v0.9.1"` (byte-identical to pre-v1.0 output). See `ToA2uiOptions.target` in `to-a2ui.ts`. */
  target?: A2uiTarget;
}

/**
 * Convert a kohaku SpecPatch into an A2UI incremental update.
 *
 * A2UI has **no component-delete message** (confirmed by research: updateComponents is upsert-only on id match;
 * deletion is expressed by updating the parent's children). Therefore:
 * - A patch without `remove`: map `upsert` onto `updateComponents.components` (upsert on id match).
 * - A patch with `remove`: since a diff alone cannot express deletion, **re-send all components after applying the patch**.
 *   This requires the applied UISpec, so pass `appliedSpec` (error if absent).
 *
 * `updateComponents` is unchanged between v0.9.1 and the v1.0 RC (verified against both schemas), so
 * `opts.target` only changes the emitted `version` string — the message shape itself is identical.
 *
 * kohaku-specific information (intent / provenance / dataVersion / refVersions / state / events /
 * baseIntentHash, plus the original ComponentNode) is preserved by the sidecar.
 */
export function patchToA2ui(
  patch: SpecPatch,
  appliedSpec?: UISpec,
  opts?: PatchToA2uiOptions,
): A2uiConversion {
  const surfaceId = surfaceIdFromIntentHash(patch.baseIntentHash);
  const hasRemove = patch.remove != null && patch.remove.length > 0;
  const version = opts?.target === "v1.0" ? A2UI_V1_VERSION : A2UI_VERSION;

  let components: A2uiComponent[];
  if (hasRemove) {
    if (appliedSpec == null) {
      throw new Error(
        "A SpecPatch containing `remove` requires a full re-send because A2UI has no component-delete message. " +
          "Pass the applied UISpec via the `appliedSpec` argument.",
      );
    }
    components = appliedSpec.components.flatMap(projectNode);
    applyEventBindings(components, appliedSpec.events);
  } else {
    components = (patch.upsert ?? []).flatMap(projectNode);
    // If the patch itself declares events, map them onto the firing components (limited to upserted components).
    if (patch.events != null) applyEventBindings(components, patch.events);
  }

  const messages: A2uiMessage[] = [{ version, updateComponents: { surfaceId, components } }];
  return { messages, sidecar: buildPatchSidecar(patch, appliedSpec) };
}

/** Build the kohaku sidecar from the SpecPatch (and, on full re-send, the appliedSpec). */
function buildPatchSidecar(patch: SpecPatch, appliedSpec?: UISpec): KohakuSidecar {
  const components: Record<string, ComponentNode> = {};
  // On full re-send, preserve all nodes after applying; otherwise preserve the upserted nodes.
  for (const c of appliedSpec?.components ?? patch.upsert ?? []) components[c.id] = c;
  return {
    baseIntentHash: patch.baseIntentHash,
    ...(patch.intent != null ? { intent: patch.intent } : {}),
    ...(patch.provenance != null ? { provenance: patch.provenance } : {}),
    ...(patch.dataVersion != null ? { dataVersion: patch.dataVersion } : {}),
    // refVersions / state also preserve null (deletion), so use an undefined check to distinguish present/absent.
    ...(patch.refVersions !== undefined ? { refVersions: patch.refVersions } : {}),
    ...(patch.state !== undefined ? { state: patch.state } : {}),
    ...(patch.events != null ? { events: patch.events } : {}),
    components,
  };
}

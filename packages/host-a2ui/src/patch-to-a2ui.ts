import type { ComponentNode, SpecPatch, UISpec } from "@kohaku-ui/spec-core";
import {
  applyEventBindings,
  KOHAKU_CATALOG_ID,
  type ProjectContext,
  projectNode,
  surfaceIdFromIntentHash,
} from "./to-a2ui.js";
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
  /**
   * Catalog resolution mode (v1.0 only; see `ToA2uiOptions.catalogMode`). Must match whatever mode the
   * surface's `createSurface` was originally opened with — `patchToA2ui` has no memory of that choice
   * across calls, so a caller running a split-mode surface must pass `catalogMode: "split"` on every
   * subsequent patch too, or its new/changed components will silently fall back to resolving against the
   * surface's default catalog. Defaults to `"single"` (byte-identical to pre-split output). `"split"` under
   * `target: "v0.9.1"` (the default target) throws, same as `toA2ui`.
   */
  catalogMode?: "single" | "split";
  /** Override for kohaku's own catalog id stamped on verbatim components (only meaningful under `catalogMode: "split"`; defaults to {@link KOHAKU_CATALOG_ID}). */
  catalogId?: string;
  /** Same as `ToA2uiOptions.rendererFunctions` (v1.0 only; throws under `target: "v0.9.1"`). Defaults to `false`. */
  rendererFunctions?: boolean;
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
  const catalogMode = opts?.catalogMode ?? "single";
  if (catalogMode === "split" && opts?.target !== "v1.0") {
    throw new Error(
      'patchToA2ui: catalogMode "split" requires target: "v1.0" (the A2UI v0.9.1 profile has no catalogId field to split with)',
    );
  }
  if (opts?.rendererFunctions === true && opts?.target !== "v1.0") {
    throw new Error(
      'patchToA2ui: rendererFunctions requires target: "v1.0" (the A2UI v0.9.1 profile has no functionCall action form)',
    );
  }
  const projectCtx: ProjectContext = { catalogMode, kohakuCatalogId: opts?.catalogId ?? KOHAKU_CATALOG_ID };
  const eventOpts = { rendererFunctions: opts?.rendererFunctions };

  let components: A2uiComponent[];
  if (hasRemove) {
    if (appliedSpec == null) {
      throw new Error(
        "A SpecPatch containing `remove` requires a full re-send because A2UI has no component-delete message. " +
          "Pass the applied UISpec via the `appliedSpec` argument.",
      );
    }
    components = appliedSpec.components.flatMap((node) => projectNode(node, projectCtx));
    applyEventBindings(components, appliedSpec.events, eventOpts);
  } else {
    components = (patch.upsert ?? []).flatMap((node) => projectNode(node, projectCtx));
    // If the patch itself declares events, map them onto the firing components (limited to upserted components).
    if (patch.events != null) applyEventBindings(components, patch.events, eventOpts);
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

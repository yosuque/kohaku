import { canonicalStringify } from "./canonical-json.js";
import { SpecError } from "./errors.js";
import type { ComponentNode } from "./schema/component.js";
import type { JsonValue } from "./schema/json.js";
import type { SpecPatch } from "./schema/patch.js";
import type { UISpec } from "./schema/spec.js";
import { hasErrors, ROOT_COMPONENT_ID, validateSpecStructure } from "./validate.js";

// The source of truth for SpecPatch is the Zod schema (schema/patch.ts). To avoid breaking the
// existing import site (@kohaku-ui/spec-core), the type is re-exported from here. The diffSpec /
// applyPatch logic is unchanged.
export type { SpecPatch } from "./schema/patch.js";

/**
 * Orders components in root-first DFS order (unreachable components sorted by id at the end).
 * This is the Spec's canonical order. Both composer's deterministic post-processing and applyPatch
 * use it.
 */
export function orderComponents(components: ComponentNode[]): ComponentNode[] {
  const byId = new Map(components.map((c) => [c.id, c]));
  const ordered: ComponentNode[] = [];
  const visited = new Set<string>();

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    const node = byId.get(id);
    if (!node) return;
    visited.add(id);
    ordered.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  visit(ROOT_COMPONENT_ID);

  // The full comparator form that returns 0 on equality (aligned with the canonical-json.ts style).
  // IDs are unique, so behavior is unchanged.
  const orphans = components
    .filter((c) => !visited.has(c.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [...ordered, ...orphans];
}

function sameJson(a: unknown, b: unknown): boolean {
  // Same reference (many components carry over the previous tree's reference unchanged when there is
  // no diff) returns true immediately without going through canonical serialization.
  if (a === b) return true;
  return canonicalStringify(a) === canonicalStringify(b);
}

/** How applyPatch applies refVersions (undefined = no change / null = remove / object = full replace). */
function nextRefVersions(prev: UISpec, patch: SpecPatch): { refVersions?: Record<string, string> } {
  if (patch.refVersions === undefined) {
    return prev.refVersions != null ? { refVersions: prev.refVersions } : {};
  }
  return patch.refVersions === null ? {} : { refVersions: patch.refVersions };
}

/** How applyPatch applies state (same shape as refVersions: undefined = no change / null = remove / object = full replace). */
function nextState(prev: UISpec, patch: SpecPatch): { state?: Record<string, JsonValue> } {
  if (patch.state === undefined) {
    return prev.state != null ? { state: prev.state } : {};
  }
  return patch.state === null ? {} : { state: patch.state };
}

/** Computes the prev → next diff as a SpecPatch. */
export function diffSpec(prev: UISpec, next: UISpec): SpecPatch {
  const patch: SpecPatch = { baseIntentHash: prev.intent.hash };

  if (prev.kohaku !== next.kohaku) patch.kohaku = next.kohaku;
  if (!sameJson(prev.intent, next.intent)) patch.intent = next.intent;

  const prevById = new Map(prev.components.map((c) => [c.id, c]));
  const nextIds = new Set(next.components.map((c) => c.id));

  const upsert = next.components.filter((c) => {
    const old = prevById.get(c.id);
    return old == null || !sameJson(old, c);
  });
  if (upsert.length > 0) patch.upsert = upsert;

  const remove = prev.components.filter((c) => !nextIds.has(c.id)).map((c) => c.id);
  if (remove.length > 0) patch.remove = remove;

  if (!sameJson(prev.events, next.events)) patch.events = next.events;
  if (prev.dataVersion !== next.dataVersion) patch.dataVersion = next.dataVersion;
  // Full replace. When next no longer has refVersions (only prev did), null signals removal.
  if (!sameJson(prev.refVersions, next.refVersions)) patch.refVersions = next.refVersions ?? null;
  // state is likewise a full replace (null = remove).
  if (!sameJson(prev.state, next.state)) patch.state = next.state ?? null;
  if (!sameJson(prev.provenance, next.provenance)) patch.provenance = next.provenance;

  return patch;
}

/**
 * Applies a patch. The resulting components are aligned to the canonical order (orderComponents) and
 * structurally validated. If prev is in canonical order, applyPatch(prev, diffSpec(prev, next))
 * equals next (in canonical order).
 */
export function applyPatch(prev: UISpec, patch: SpecPatch): UISpec {
  if (patch.baseIntentHash !== prev.intent.hash) {
    throw new SpecError(
      "PATCH_BASE_MISMATCH",
      `patch targets intent ${patch.baseIntentHash} but spec has ${prev.intent.hash}`,
    );
  }

  const byId = new Map(prev.components.map((c) => [c.id, c]));
  for (const id of patch.remove ?? []) byId.delete(id);
  for (const c of patch.upsert ?? []) byId.set(c.id, c);

  const next: UISpec = {
    kohaku: patch.kohaku ?? prev.kohaku,
    intent: patch.intent ?? prev.intent,
    dataVersion: patch.dataVersion ?? prev.dataVersion,
    // undefined = no change (keep prev) / null = remove / object = full replace
    ...nextRefVersions(prev, patch),
    ...nextState(prev, patch),
    components: orderComponents([...byId.values()]),
    events: patch.events ?? prev.events,
    provenance: patch.provenance ?? prev.provenance,
  };

  const issues = validateSpecStructure(next);
  if (hasErrors(issues)) {
    throw new SpecError(
      "PATCH_APPLY_FAILED",
      `patched spec is structurally invalid: ${issues
        .filter((i) => i.severity === "error")
        .map((i) => i.code)
        .join(", ")}`,
      issues,
    );
  }
  return next;
}

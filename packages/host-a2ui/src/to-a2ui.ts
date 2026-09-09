import type { ComponentNode, EventBinding, JsonValue, TabularData, UISpec } from "@kohaku-ui/spec-core";
import {
  A2UI_V1_VERSION,
  A2UI_VERSION,
  type A2uiComponent,
  type A2uiConversion,
  type A2uiCreateSurfaceV1,
  type A2uiMessage,
  type A2uiTarget,
  type KohakuSidecar,
} from "./types.js";

/**
 * kohaku's catalog id. Since kohaku types not in the basic catalog (presentChart, etc.) also ride verbatim,
 * this declares kohaku's own catalog rather than the standard basic one. Overridable via opts.catalogId.
 */
export const KOHAKU_CATALOG_ID = "https://kohaku-ui.dev/a2ui/catalogs/core.json";

/**
 * Core component mapping table (v0.9.1). kohaku types listed here map to a component in the A2UI basic catalog.
 * - layout.stack: emits Row / Column depending on direction (handled case-by-case in projectNode below)
 * - text.heading / presentMarkdown → Text, action.button → Button (handled case-by-case in projectNode below)
 * - **layout.grid → Grid is dropped** (the v0.9.1 basic catalog has no Grid, so it is demoted to verbatim + sidecar preservation)
 * For a type not listed, the kohaku type goes into component as-is and the sidecar preserves the original.
 */

/** Derive a deterministic surfaceId from the sha256:<hex> intent hash (matches between a spec and its patch). */
export function surfaceIdFromIntentHash(hash: string): string {
  return `kohaku-${hash.replace(/^sha256:/, "")}`;
}

/** RFC 6901 token escaping (~ → ~0, / → ~1; escape ~ first). */
export function escapeJsonPointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Map kohaku's action.button variant (primary/secondary/danger) to an A2UI Button variant. */
function mapButtonVariant(variant: JsonValue | undefined): string {
  // A2UI Button variants are default / primary / borderless. secondary/danger are mapped to the nearest primary/default,
  // and the original value is preserved by the sidecar (the original ComponentNode).
  if (variant === "primary" || variant === "danger") return "primary";
  return "default";
}

/**
 * Project a kohaku ComponentNode onto A2UI component(s) (1 node → 1 or more).
 * For action.button, since an A2UI Button requires a child Text, a label Text is synthesized and two are returned.
 * Non-core types (including layout.grid) put the kohaku type into component verbatim and inline the props.
 */
export function projectNode(node: ComponentNode): A2uiComponent[] {
  switch (node.type) {
    case "layout.stack": {
      // Vertical stack = Column, horizontal stack = Row. Copy justify / align if present (props A2UI lacks, such as gap, are dropped).
      const component = node.props["direction"] === "horizontal" ? "Row" : "Column";
      const out: A2uiComponent = { id: node.id, component };
      if (node.children != null) out.children = node.children;
      if (typeof node.props["justify"] === "string") out["justify"] = node.props["justify"];
      if (typeof node.props["align"] === "string") out["align"] = node.props["align"];
      return [out];
    }
    case "text.heading": {
      // level → variant (h1/h2/…), text → text. A2UI Text interprets markdown notation directly in text.
      const out: A2uiComponent = { id: node.id, component: "Text", text: asText(node.props["text"]) };
      const level = node.props["level"];
      if (typeof level === "number") out["variant"] = `h${level}`;
      return [out];
    }
    case "presentMarkdown": {
      // markdown → Text.text (A2UI Text interprets markdown; no format flag is added because of unevaluatedProperties:false).
      return [{ id: node.id, component: "Text", text: asText(node.props["markdown"]) }];
    }
    case "action.button": {
      // An A2UI Button requires child (the label component's id) + action. Synthesize a label Text.
      const labelId = `${node.id}__label`;
      const label: A2uiComponent = { id: labelId, component: "Text", text: asText(node.props["label"]) };
      const button: A2uiComponent = {
        id: node.id,
        component: "Button",
        child: labelId,
        variant: mapButtonVariant(node.props["variant"]),
        // A Button requires an action. It is overwritten by event mapping, but a default press action is placed so it holds even when unbound.
        action: { event: { name: `${node.id}.press`, context: {} } },
      };
      return [button, label];
    }
    default:
      return [verbatimComponent(node)];
  }
}

/** Map a type outside the core mapping table verbatim (component = kohaku type, props inlined, children preserved). */
function verbatimComponent(node: ComponentNode): A2uiComponent {
  const out: A2uiComponent = { id: node.id, component: node.type };
  for (const [key, value] of Object.entries(node.props)) {
    // Do not project prop names that collide with structural keys (they normally do not appear in kohaku props).
    if (key === "id" || key === "component" || key === "children" || key === "child" || key === "action") {
      continue;
    }
    out[key] = value;
  }
  if (node.children != null) out.children = node.children;
  return out;
}

/** Convert a text-like prop value to a display string. null/undefined become the empty string. */
function asText(value: JsonValue | undefined): string {
  return value == null ? "" : String(value);
}

/**
 * Map a spec-level EventBinding onto the firing component's `action.event` (A2UI holds the action on the component side).
 * The <componentId> in `on: "<componentId>.<eventName>"` is the firing component, and action.event.name gets `on` as-is
 * (so fromA2uiEvent can convert it back cleanly on round-trip). context is empty (the client resolves the values).
 * kohaku-specific information such as the emit target / payload is preserved by the sidecar (events).
 */
export function applyEventBindings(components: A2uiComponent[], events: readonly EventBinding[]): void {
  if (events.length === 0) return;
  const byId = new Map(components.map((c) => [c.id, c] as const));
  for (const ev of events) {
    const dot = ev.on.indexOf(".");
    const sourceId = dot >= 0 ? ev.on.slice(0, dot) : ev.on;
    const target = byId.get(sourceId);
    if (target == null) continue; // Skip if the firing component was not projected (tolerated by this skeleton)
    target.action = { event: { name: ev.on, context: {} } };
  }
}

/** Enumerate the data.$ref values in the spec in order of appearance, deduplicated (for inline expansion into updateDataModel). */
function uniqueRefs(spec: UISpec): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const c of spec.components) {
    if (c.data != null && !seen.has(c.data.$ref)) {
      seen.add(c.data.$ref);
      refs.push(c.data.$ref);
    }
  }
  return refs;
}

/** Collect the source Spec's kohaku-specific metadata into the sidecar (components is id → the original ComponentNode). */
function buildSidecar(spec: UISpec): KohakuSidecar {
  const components: Record<string, ComponentNode> = {};
  for (const c of spec.components) components[c.id] = c;
  return {
    intent: spec.intent,
    provenance: spec.provenance,
    dataVersion: spec.dataVersion,
    ...(spec.refVersions != null ? { refVersions: spec.refVersions } : {}),
    ...(spec.state != null ? { state: spec.state } : {}),
    events: spec.events,
    components,
  };
}

export interface ToA2uiOptions {
  /** Override for createSurface.catalogId (defaults to {@link KOHAKU_CATALOG_ID}). */
  catalogId?: string;
  /**
   * Inline-expand data into updateDataModel for non-supporting clients (opt-in, lossy conversion).
   * **When not specified, no data is included** (reference-passing is preserved by the sidecar's ComponentNode.data);
   * only when specified is each data.$ref resolved and placed at `/refs/<RFC6901-escaped raw ref>`.
   * Under `target: "v1.0"` the same resolved data is bundled directly into `createSurface.dataModel`
   * (as `{ refs: { "<raw ref>": TabularData } }`, unescaped since it is a plain object key, not a JSON Pointer).
   */
  resolveData?: (ref: string) => Promise<TabularData>;
  /**
   * Output wire target. Defaults to `"v0.9.1"` (existing behavior, **byte-identical**; fixed by a golden test).
   * `"v1.0"` follows the A2UI v1.0 RC: `version: "v1.0"`, `createSurface` bundles `components` (and, when
   * `resolveData` is given, `dataModel`) directly instead of separate `updateComponents`/`updateDataModel`
   * messages, and no `theme` field is emitted (removed in the RC).
   */
  target?: A2uiTarget;
}

/**
 * Convert a kohaku UISpec into an A2UI message sequence + a kohaku sidecar.
 *
 * Default (`target` omitted or `"v0.9.1"`): messages are the two `createSurface` → `updateComponents`
 * (plus an `updateDataModel` per ref only when resolveData is given). All are strictly v0.9.1-compliant
 * and carry no kohaku-specific information whatsoever (the sidecar preserves it losslessly).
 *
 * `target: "v1.0"`: a single `createSurface` message bundles `components` (and, when `resolveData` is
 * given, `dataModel`) directly — see {@link ToA2uiOptions.target}.
 *
 * surfaceId is derived deterministically from intent.hash in both targets.
 */
export async function toA2ui(spec: UISpec, opts?: ToA2uiOptions): Promise<A2uiConversion> {
  const surfaceId = surfaceIdFromIntentHash(spec.intent.hash);
  const catalogId = opts?.catalogId ?? KOHAKU_CATALOG_ID;

  const components = spec.components.flatMap(projectNode);
  applyEventBindings(components, spec.events);

  if (opts?.target === "v1.0") {
    const createSurface: A2uiCreateSurfaceV1 = { surfaceId, catalogId, components };
    if (opts.resolveData != null) {
      const refs = uniqueRefs(spec);
      if (refs.length > 0) {
        // Unlike the v0.9.1 path below (where message order is observable — each ref becomes its own
        // sequential updateDataModel message), this v1.0 path only fills entries of one order-independent
        // `dataModel.refs` object, so resolving every ref concurrently is safe.
        const resolveData = opts.resolveData;
        const entries = await Promise.all(
          refs.map(async (ref) => [ref, (await resolveData(ref)) as unknown as JsonValue] as const),
        );
        // Object key: the raw ref is used verbatim (RFC 6901 escaping only applies to JSON Pointer path segments).
        createSurface.dataModel = { refs: Object.fromEntries(entries) };
      }
    }
    const messages: A2uiMessage[] = [{ version: A2UI_V1_VERSION, createSurface }];
    return { messages, sidecar: buildSidecar(spec) };
  }

  const messages: A2uiMessage[] = [
    { version: A2UI_VERSION, createSurface: { surfaceId, catalogId } },
    { version: A2UI_VERSION, updateComponents: { surfaceId, components } },
  ];

  if (opts?.resolveData != null) {
    for (const ref of uniqueRefs(spec)) {
      const data = await opts.resolveData(ref);
      messages.push({
        version: A2UI_VERSION,
        updateDataModel: {
          surfaceId,
          // Place it at `/refs/<raw ref>` in the data model (the raw ref is RFC 6901-escaped).
          path: `/refs/${escapeJsonPointerToken(ref)}`,
          // TabularData is a JSON structure (columns/rows/dataVersion), so it can be preserved as JsonValue.
          value: data as unknown as JsonValue,
        },
      });
    }
  }

  return { messages, sidecar: buildSidecar(spec) };
}

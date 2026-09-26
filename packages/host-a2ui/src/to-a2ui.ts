import type { ComponentNode, EventBinding, JsonValue, TabularData, UISpec } from "@kohaku-ui/spec-core";
import {
  A2UI_V1_BASIC_CATALOG_ID,
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
 * In `catalogMode: "split"` (v1.0 only), this is the id stamped onto each non-basic component's own
 * `catalogId` field instead of the surface's default (see {@link ProjectContext}).
 */
export const KOHAKU_CATALOG_ID = "https://kohaku-ui.dev/a2ui/catalogs/core.json";

/**
 * How catalog resolution is split between kohaku's own catalog and the A2UI basic catalog (v1.0 RC only;
 * `"single"` is the only mode v0.9.1 supports, since it has no `catalogId` field at all).
 * - `"single"` (default): one catalog id covers both the basic-shaped components (Row/Column/Text/Button)
 *   and kohaku's own verbatim types, so no component needs its own `catalogId` (all resolve via the
 *   surface's default). Byte-identical to pre-split output.
 * - `"split"`: the surface's default `catalogId` becomes the real A2UI basic catalog
 *   ({@link A2UI_V1_BASIC_CATALOG_ID}, overridable via `basicCatalogId`), and every verbatim (non-basic)
 *   kohaku component gets an explicit `catalogId` (defaulting to {@link KOHAKU_CATALOG_ID}, overridable via
 *   `catalogId`) so it still resolves per the RC's "component `catalogId` → surface default → resolution
 *   error" rule.
 */
export interface ProjectContext {
  catalogMode?: "single" | "split";
  /** The catalogId stamped onto verbatim (non-basic) components in `"split"` mode. */
  kohakuCatalogId?: string;
}

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
 * `ctx` is only consulted by the non-core (verbatim) path — the core-mapped types (Row/Column/Text/Button)
 * are always basic-catalog shapes and never carry a `catalogId` of their own, in either catalog mode.
 */
export function projectNode(node: ComponentNode, ctx?: ProjectContext): A2uiComponent[] {
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
      return [verbatimComponent(node, ctx)];
  }
}

/**
 * Map a type outside the core mapping table verbatim (component = kohaku type, props inlined, children
 * preserved). In `ctx.catalogMode === "split"`, also stamps `catalogId` (kohaku's own catalog, since a
 * verbatim type by definition is not in the A2UI basic catalog the surface otherwise defaults to).
 */
function verbatimComponent(node: ComponentNode, ctx?: ProjectContext): A2uiComponent {
  const out: A2uiComponent = { id: node.id, component: node.type };
  for (const [key, value] of Object.entries(node.props)) {
    // Do not project prop names that collide with structural keys (they normally do not appear in kohaku props).
    if (
      key === "id" ||
      key === "component" ||
      key === "children" ||
      key === "child" ||
      key === "action" ||
      key === "catalogId"
    ) {
      continue;
    }
    out[key] = value;
  }
  if (node.children != null) out.children = node.children;
  if (ctx?.catalogMode === "split") out.catalogId = ctx.kohakuCatalogId ?? KOHAKU_CATALOG_ID;
  return out;
}

/** Convert a text-like prop value to a display string. null/undefined become the empty string. */
function asText(value: JsonValue | undefined): string {
  return value == null ? "" : String(value);
}

/**
 * The v1.0 RC catalog function name `applyEventBindings` emits a `state.set` `EventBinding` as, under
 * `rendererFunctions: true` (see `ToA2uiOptions.rendererFunctions`). Declared in the kohaku catalog document
 * by `catalog-document.ts` with `allowedCallers: "rendererOnly"` (kohaku never calls it from the agent side).
 */
export const KOHAKU_SET_STATE_FUNCTION = "kohaku.setState";

/**
 * Map a spec-level EventBinding onto the firing component's `action` (A2UI holds the action on the component side).
 * The <componentId> in `on: "<componentId>.<eventName>"` is the firing component. context is empty (the client
 * resolves the values). kohaku-specific information such as the emit target / payload is preserved by the sidecar
 * (events), except when `rendererFunctions` recovers `state.set`'s `{key, value}` onto the wire directly (below).
 *
 * `rendererFunctions` (v1.0 RC only): a `state.set` binding — a client-local state update with no server
 * round-trip (SPEC-EVT-002) — is instead projected as `action.functionCall` calling
 * {@link KOHAKU_SET_STATE_FUNCTION} with `args: {key, value}`, rather than the generic `action.event` form
 * (which would misrepresent it as a server-notifying event). Every other emit kind (`intent.patch` /
 * `intent.replace` / `action.invoke`) is unaffected — only a real A2UI client that also understands kohaku's
 * catalog function can execute it locally; a generic client without that awareness simply has no action to
 * fire for that component, same as if the event had been dropped, so this option only ever adds information
 * for clients that request it, never a lossier substitute.
 */
export function applyEventBindings(
  components: A2uiComponent[],
  events: readonly EventBinding[],
  opts?: { rendererFunctions?: boolean },
): void {
  if (events.length === 0) return;
  const byId = new Map(components.map((c) => [c.id, c] as const));
  for (const ev of events) {
    const dot = ev.on.indexOf(".");
    const sourceId = dot >= 0 ? ev.on.slice(0, dot) : ev.on;
    const target = byId.get(sourceId);
    if (target == null) continue; // Skip if the firing component was not projected (tolerated by this skeleton)
    if (opts?.rendererFunctions === true && ev.emit === "state.set") {
      target.action = {
        functionCall: {
          call: KOHAKU_SET_STATE_FUNCTION,
          catalogId: KOHAKU_CATALOG_ID,
          args: { key: ev.payload["key"] ?? null, value: ev.payload["value"] ?? null },
        },
      };
      continue;
    }
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
  /**
   * Catalog resolution mode (v1.0 only; see {@link ProjectContext}). Defaults to `"single"` (byte-identical
   * to pre-split output). Requesting `"split"` under `target: "v0.9.1"` (the default target) throws, since
   * v0.9.1 has no `catalogId` field to split with.
   */
  catalogMode?: "single" | "split";
  /**
   * Override for the basic catalog's URI (only meaningful under `catalogMode: "split"`; defaults to
   * {@link A2UI_V1_BASIC_CATALOG_ID}). Kept overridable because the RC's catalog URIs are not yet final.
   */
  basicCatalogId?: string;
  /**
   * Project a `state.set` `EventBinding` as an `action.functionCall` to {@link KOHAKU_SET_STATE_FUNCTION}
   * instead of the generic `action.event` form (v1.0 only; see `applyEventBindings`'s doc). Defaults to
   * `false` (byte-identical to pre-v1.0 output). `true` under `target: "v0.9.1"` (the default target) throws,
   * since v0.9.1 has no `functionCall` action form.
   */
  rendererFunctions?: boolean;
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
  const catalogMode = opts?.catalogMode ?? "single";
  if (catalogMode === "split" && opts?.target !== "v1.0") {
    throw new Error(
      'toA2ui: catalogMode "split" requires target: "v1.0" (the A2UI v0.9.1 profile has no catalogId field to split with)',
    );
  }
  if (opts?.rendererFunctions === true && opts?.target !== "v1.0") {
    throw new Error(
      'toA2ui: rendererFunctions requires target: "v1.0" (the A2UI v0.9.1 profile has no functionCall action form)',
    );
  }
  const kohakuCatalogId = opts?.catalogId ?? KOHAKU_CATALOG_ID;
  // In "split" mode the surface's own default catalogId becomes the basic catalog (kohaku's own types
  // instead carry an explicit per-component catalogId — see projectNode/verbatimComponent); in "single"
  // mode (the default) one catalog id covers both, so the surface default IS kohaku's own catalog id.
  const catalogId =
    catalogMode === "split" ? (opts?.basicCatalogId ?? A2UI_V1_BASIC_CATALOG_ID) : kohakuCatalogId;
  const projectCtx: ProjectContext = { catalogMode, kohakuCatalogId };

  const components = spec.components.flatMap((node) => projectNode(node, projectCtx));
  applyEventBindings(components, spec.events, { rendererFunctions: opts?.rendererFunctions });

  if (opts?.target === "v1.0") {
    const createSurface: A2uiCreateSurfaceV1 = { surfaceId, catalogId, components };
    if (opts.resolveData != null) {
      const refs = uniqueRefs(spec);
      if (refs.length > 0) {
        // Both this path and the v0.9.1 path below now resolve every ref concurrently (Promise.all). The
        // difference is only in what each does with the results: this v1.0 path fills entries of one
        // order-independent `dataModel.refs` object, so it merely needs every ref's value, in any order.
        // The v0.9.1 path still cares about order — each ref becomes its own sequential updateDataModel
        // message — so it pushes the resolved values back in uniqueRefs order even though they were
        // fetched concurrently.
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
    const refs = uniqueRefs(spec);
    const resolveData = opts.resolveData;
    // Resolve every ref concurrently (same rationale as the v1.0 path above), but push the resulting
    // messages in uniqueRefs order regardless — this path's message order is observable (each ref becomes
    // its own sequential updateDataModel message), so concurrent fetching must not reorder them.
    const values = await Promise.all(refs.map((ref) => resolveData(ref)));
    for (const [i, ref] of refs.entries()) {
      messages.push({
        version: A2UI_VERSION,
        updateDataModel: {
          surfaceId,
          // Place it at `/refs/<raw ref>` in the data model (the raw ref is RFC 6901-escaped).
          path: `/refs/${escapeJsonPointerToken(ref)}`,
          // TabularData is a JSON structure (columns/rows/dataVersion), so it can be preserved as JsonValue.
          value: values[i] as unknown as JsonValue,
        },
      });
    }
  }

  return { messages, sidecar: buildSidecar(spec) };
}

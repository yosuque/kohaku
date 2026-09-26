import {
  type CanonicalIntent,
  type ComponentNode,
  type EventBinding,
  hasErrors,
  type JsonObject,
  type JsonValue,
  SPEC_VERSION,
  type UISpec,
  validateSpecStructure,
} from "@kohaku-ui/spec-core";
import type { A2uiBinding, A2uiComponent, A2uiFunctionCall, A2uiValue, KohakuSidecar } from "../types.js";
import { A2uiIngestError, getAtPointer, getRootComponent, type SurfaceState } from "./reduce.js";

/**
 * Converts an accumulated `SurfaceState` (a third-party A2UI agent's surface, or kohaku's own re-ingested
 * output) into a kohaku `UISpec`. This is the counterpart of `toA2ui`, but not its exact inverse: a
 * genuinely third-party surface carries no `KohakuSidecar`, so most of the mapping below is the best-effort,
 * potentially-lossy reconstruction described in the F3 brief (`§4`), not a lossless replay. **No LLM is ever
 * called here** — every unrepresentable case is handled deterministically (a fixed placeholder, or a thrown
 * error), never regenerated.
 */

/** Every kind of information loss `fromA2ui` can record when `unmappable: "fallback"` (the default). */
export type A2uiIngestLossKind =
  | "unknown-component"
  | "template-children"
  | "function-call-value"
  | "binding-snapshotted";

/** One recorded loss (kept even in the common case of zero losses, so a caller can always check `.length`). */
export interface A2uiIngestLoss {
  /** The (kohaku-side) id of the component the loss occurred on. */
  componentId: string;
  kind: A2uiIngestLossKind;
  detail: string;
}

export interface FromA2uiOptions {
  /** The Spec's Intent (already resolved/hashed by the caller — see `createA2uiIngest`, task 5). */
  intent: CanonicalIntent;
  /** The Spec's dataVersion (already derived by the caller). */
  dataVersion: string;
  /**
   * Membership test for kohaku's own catalog: a component whose A2UI `component` name is not one of the
   * core-mapped basic types (Row/Column/Text/Button) is passed through verbatim (props inlined, same as
   * `to-a2ui.ts`'s `verbatimComponent`) when `catalog.has(type)` is true, and treated as
   * `"unknown-component"` otherwise. Omitted = nothing is recognized (every non-core type is unmappable).
   */
  catalog?: { has(type: string): boolean };
  /**
   * How to handle a component/value this profile cannot represent (see {@link A2uiIngestLossKind}).
   * `"fallback"` (default): replace the offending component with a deterministic `presentMarkdown`
   * placeholder and record the loss. `"reject"`: throw `A2uiIngestError`, failing the whole conversion.
   * A `"binding-snapshotted"` loss (see `bindPath` below) is never subject to this policy — it always just
   * snapshots and records, since a `{path}` binding IS representable (as a literal), just not live.
   */
  unmappable?: "fallback" | "reject";
  /**
   * Escape hatch for a `{path}` data binding: return a kohaku query `$ref` for that path to preserve
   * reference-passing instead of a one-time literal snapshot (a caller wires this when it knows which A2UI
   * data-model paths correspond to a live kohaku query it can re-resolve). Returning `undefined` (including
   * when this option itself is omitted) falls back to a literal snapshot for that one path, recorded as a
   * `"binding-snapshotted"` loss.
   */
  bindPath?: (path: string) => { $ref: string } | undefined;
  /**
   * The sidecar `toA2ui`/`patchToA2ui` returned for this exact surface, if this surface is kohaku's own
   * prior output re-ingested (the round-trip case, not third-party content). When a component id has a
   * sidecar entry, it is restored **verbatim and losslessly** from `sidecar.components[id]`, bypassing every
   * mapping rule below entirely.
   */
  sidecar?: KohakuSidecar;
}

export interface FromA2uiResult {
  spec: UISpec;
  /** Every loss recorded during this conversion, in component-traversal order. Empty when nothing was lossy. */
  losses: A2uiIngestLoss[];
}

/** Internal signal for "this component/value cannot be represented", caught centrally per-component (see `fromA2ui`). Never escapes this module. */
class UnmappableSignal extends Error {
  constructor(
    readonly kind: A2uiIngestLossKind,
    detail: string,
  ) {
    super(detail);
  }
}

/**
 * Best-effort mapping of an arbitrary wire component id to a valid kohaku `ComponentId`
 * (`^[a-zA-Z][a-zA-Z0-9_-]{0,63}$` — spec-core's `ComponentIdSchema`). Third-party A2UI ids are
 * unconstrained strings and routinely violate this (leading digits, unicode, punctuation, length); every
 * character outside the allowed alphabet is replaced with `_`, a non-letter start is prefixed, and the
 * result is capped at 64 chars. This is deterministic per input but not guaranteed collision-free — two
 * different wire ids that happen to sanitize to the same kohaku id would surface as `validateSpecStructure`'s
 * `DUPLICATE_ID`, which `fromA2ui` turns into a thrown `A2uiIngestError` (fail closed, never a silent merge).
 * A wire id already valid (the overwhelmingly common case, and always true for `"root"` itself) passes
 * through unchanged.
 */
export function toKohakuComponentId(rawId: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(rawId)) return rawId;
  const replaced = rawId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  const withLeadingLetter = /^[a-zA-Z]/.test(replaced) ? replaced : `c_${replaced}`;
  return (withLeadingLetter === "" ? "c" : withLeadingLetter).slice(0, 64);
}

/** Best-effort mapping of an arbitrary wire event name to kohaku's `EventOnSchema` second segment (`[a-zA-Z][a-zA-Z0-9]*`, no `_`/`-`). */
function toKohakuEventNamePart(rawName: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(rawName)) return rawName;
  const stripped = rawName.replace(/[^a-zA-Z0-9]/g, "");
  const withLeadingLetter = /^[a-zA-Z]/.test(stripped) ? stripped : `e${stripped}`;
  return withLeadingLetter === "" ? "event" : withLeadingLetter;
}

function isBindingValue(value: A2uiValue): value is A2uiBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { path?: unknown }).path === "string" &&
    Object.keys(value).length === 1
  );
}

function isFunctionCallValue(value: A2uiValue): value is A2uiFunctionCall {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { call?: unknown }).call === "string"
  );
}

interface ConvertCtx {
  surface: SurfaceState;
  catalog?: { has(type: string): boolean };
  bindPath?: (path: string) => { $ref: string } | undefined;
  sidecar?: KohakuSidecar;
  losses: A2uiIngestLoss[];
  events: EventBinding[];
}

/**
 * Resolves one `A2uiValue` to a literal `JsonValue`. A `{path}` binding is snapshotted from the surface's
 * data model (or replaced by `ctx.bindPath`'s `$ref`, used verbatim as the resolved value — see
 * `FromA2uiOptions.bindPath`'s doc); this always succeeds and only ever *records* a loss, it never throws.
 * A function-call value throws `UnmappableSignal` (fromA2ui cannot execute it), demoting the *whole*
 * containing component to a placeholder — a computed value is not a "leave this one field null" situation,
 * since the value's meaning wasn't just uncertain, it was never asked for from a fixed data source at all.
 */
function resolveValue(value: A2uiValue, ctx: ConvertCtx, componentId: string, hint: string): JsonValue {
  if (isBindingValue(value)) {
    const ref = ctx.bindPath?.(value.path);
    if (ref != null) return ref as unknown as JsonValue;
    const snapshot = getAtPointer(ctx.surface.dataModel, value.path);
    ctx.losses.push({
      componentId,
      kind: "binding-snapshotted",
      detail: `"${hint}" bound to data model path "${value.path}" was resolved once to a literal snapshot`,
    });
    return snapshot ?? null;
  }
  if (isFunctionCallValue(value)) {
    throw new UnmappableSignal(
      "function-call-value",
      `"${hint}" is a computed function-call value ({call:"${value.call}"}), which fromA2ui cannot execute`,
    );
  }
  return value;
}

function resolveTextValue(
  value: A2uiValue | undefined,
  ctx: ConvertCtx,
  componentId: string,
  hint: string,
): string {
  if (value == null) return "";
  const resolved = resolveValue(value, ctx, componentId, hint);
  return resolved == null ? "" : String(resolved);
}

type ChildrenResolution = { kind: "none" } | { kind: "array"; ids: string[] } | { kind: "template" };

/** `A2uiChildren` → kohaku's static id array, or `{kind:"template"}` when it is the data-bound iteration form. */
function resolveChildren(node: A2uiComponent): ChildrenResolution {
  if (node.children == null) return { kind: "none" };
  if (Array.isArray(node.children)) {
    return { kind: "array", ids: node.children.map(toKohakuComponentId) };
  }
  return { kind: "template" };
}

/**
 * Maps a firing component's `action` onto a kohaku `EventBinding` pushed onto `ctx.events`, so the ingested
 * Spec is genuinely interactive in kohaku's own renderer (not just visually reconstructed) and a later
 * interaction can be routed back to the original agent via `toA2uiClientAction` (task 6). Only `action.event`
 * produces one: `emit: "action.invoke"` is the closest existing kohaku emit kind to "an opaque client
 * interaction the server/agent should hear about" (the same kind kohaku's own outbound `action.button`
 * fixtures use — see `to-a2ui.ts`'s test suite). A `functionCall` action is client-local by A2UI's own
 * definition (see `A2uiComponentAction`'s doc comment: "handled entirely on the client, e.g. openUrl") —
 * there is no server-bound notification to route for it, so no EventBinding is produced (not a loss either:
 * a client-local action legitimately has nothing to forward).
 *
 * The wire's `event.name` is not reused as-is for `on`'s second segment: kohaku's `EventOnSchema` requires
 * `[a-zA-Z][a-zA-Z0-9]*` there, while a third-party agent's event name is an unconstrained string. When the
 * name already satisfies that shape (the common case: "press", "click", "rowClick", …) it survives unchanged,
 * so `toA2uiClientAction`'s reverse mapping (splitting `on` on its first `.`) recovers the exact original
 * name; a name that does not already satisfy it is deterministically sanitized instead, which is a real,
 * documented (README "governance proxy" section) loss of exact fidelity for that one case.
 */
function attachEvent(result: ComponentNode, node: A2uiComponent, ctx: ConvertCtx): void {
  if (node.action == null) return;
  if (!("event" in node.action)) return;
  const rawName = node.action.event.name;
  // A wire event.name already in this profile's own "<id>.<eventName>" convention (kohaku's outbound
  // projection emits exactly that, see to-a2ui.ts's applyEventBindings) is re-prefixed rather than
  // double-prefixed — relevant when a kohaku-origin surface is re-ingested without its sidecar (the sidecar
  // path bypasses this function entirely via verbatim restoration, so this only matters without one).
  const ownPrefix = `${result.id}.`;
  const eventNamePart = toKohakuEventNamePart(
    rawName.startsWith(ownPrefix) ? rawName.slice(ownPrefix.length) : rawName,
  );
  const payload: JsonObject = {};
  for (const [key, value] of Object.entries(node.action.event.context)) {
    payload[key] = resolveValue(value, ctx, result.id, `action.event.context.${key}`);
  }
  ctx.events.push({ on: `${result.id}.${eventNamePart}`, emit: "action.invoke", payload });
}

/** Converts one raw component (identified by its *wire* id) into exactly one `ComponentNode`, or throws `UnmappableSignal`. */
function convertOne(rawId: string, node: A2uiComponent, ctx: ConvertCtx): ComponentNode {
  const restored = ctx.sidecar?.components[rawId];
  if (restored != null) return restored;

  const id = toKohakuComponentId(rawId);

  switch (node.component) {
    case "Row":
    case "Column": {
      const children = resolveChildren(node);
      if (children.kind === "template") {
        throw new UnmappableSignal(
          "template-children",
          `"${node.component}" uses a data-bound repeated template ({children:{path,componentId}}), which kohaku's static children array cannot express`,
        );
      }
      const props: JsonObject = { direction: node.component === "Row" ? "horizontal" : "vertical" };
      if (typeof node["justify"] === "string") props["justify"] = node["justify"];
      if (typeof node["align"] === "string") props["align"] = node["align"];
      const result: ComponentNode = { id, type: "layout.stack", props };
      if (children.kind === "array") result.children = children.ids;
      attachEvent(result, node, ctx);
      return result;
    }
    case "Text": {
      const text = resolveTextValue(node["text"] as A2uiValue | undefined, ctx, id, "text");
      const variant = node["variant"];
      const headingLevel = typeof variant === "string" ? /^h([1-6])$/.exec(variant)?.[1] : undefined;
      const result: ComponentNode =
        headingLevel != null
          ? { id, type: "text.heading", props: { level: Number(headingLevel), text } }
          : { id, type: "presentMarkdown", props: { markdown: text } };
      attachEvent(result, node, ctx);
      return result;
    }
    case "Button": {
      let label = "";
      if (typeof node.child === "string") {
        const labelNode = ctx.surface.components[node.child];
        if (labelNode != null) {
          label = resolveTextValue(labelNode["text"] as A2uiValue | undefined, ctx, id, "child.text");
        }
      }
      // Best-effort reverse of to-a2ui.ts's mapButtonVariant (primary/danger -> primary, else -> default):
      // that mapping is lossy (secondary and danger both become the wire's "primary"/"default"), so this can
      // only recover "primary" vs. a generic "secondary" — never the original "danger" without a sidecar.
      const variant = node["variant"] === "primary" ? "primary" : "secondary";
      const result: ComponentNode = { id, type: "action.button", props: { label, variant } };
      attachEvent(result, node, ctx);
      return result;
    }
    default: {
      if (ctx.catalog?.has(node.component) !== true) {
        throw new UnmappableSignal(
          "unknown-component",
          `unknown A2UI component "${node.component}" (not in the core mapping table or the supplied catalog)`,
        );
      }
      const children = resolveChildren(node);
      if (children.kind === "template") {
        throw new UnmappableSignal(
          "template-children",
          `"${node.component}" uses a data-bound repeated template ({children:{path,componentId}}), which kohaku's static children array cannot express`,
        );
      }
      const props: JsonObject = {};
      for (const [key, value] of Object.entries(node)) {
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
        props[key] = resolveValue(value as A2uiValue, ctx, id, key);
      }
      const result: ComponentNode = { id, type: node.component, props };
      if (children.kind === "array") result.children = children.ids;
      attachEvent(result, node, ctx);
      return result;
    }
  }
}

/**
 * A sidecar-restored `action.button` absorbs its synthesized label (`to-a2ui.ts` always names it
 * `${id}__label`) into `props.label`; a genuinely third-party `Button` absorbs whatever id its own `child`
 * field names. Either way, the label must not *also* be independently emitted as its own top-level
 * component — this is computed as a full pre-pass (not inline during conversion) so that traversal order
 * can never emit the label before learning it is consumed (`Object.entries` order is insertion order, not a
 * guarantee that a Button is visited before its label).
 */
function computeConsumedLabelIds(surface: SurfaceState, sidecar?: KohakuSidecar): Set<string> {
  const consumed = new Set<string>();
  for (const [rawId, node] of Object.entries(surface.components)) {
    const restored = sidecar?.components[rawId];
    if (restored != null) {
      if (restored.type === "action.button") consumed.add(`${rawId}__label`);
      continue;
    }
    if (node.component === "Button" && typeof node.child === "string") consumed.add(node.child);
  }
  return consumed;
}

/** See the module doc comment above. */
export function fromA2ui(surface: SurfaceState, opts: FromA2uiOptions): FromA2uiResult {
  // Fail fast: a surface with no root cannot become a Spec at all (nothing later depends on this call, it
  // is purely a precondition check — validateSpecStructure below would catch MISSING_ROOT too, but this
  // gives a clearer, ingest-specific error before any conversion work happens).
  getRootComponent(surface);

  const policy = opts.unmappable ?? "fallback";
  const consumedIds = computeConsumedLabelIds(surface, opts.sidecar);
  const losses: A2uiIngestLoss[] = [];
  const events: EventBinding[] = [];
  const ctx: ConvertCtx = {
    surface,
    ...(opts.catalog != null ? { catalog: opts.catalog } : {}),
    ...(opts.bindPath != null ? { bindPath: opts.bindPath } : {}),
    ...(opts.sidecar != null ? { sidecar: opts.sidecar } : {}),
    losses,
    events,
  };

  const components: ComponentNode[] = [];
  for (const [rawId, node] of Object.entries(surface.components)) {
    if (consumedIds.has(rawId)) continue;
    const id = toKohakuComponentId(rawId);
    try {
      components.push(convertOne(rawId, node, ctx));
    } catch (e) {
      if (!(e instanceof UnmappableSignal)) throw e;
      if (policy === "reject") {
        throw new A2uiIngestError(
          `A2UI ingest: cannot represent component "${id}" (${e.kind}): ${e.message}`,
        );
      }
      losses.push({ componentId: id, kind: e.kind, detail: e.message });
      components.push({
        id,
        type: "presentMarkdown",
        props: { markdown: `_Unsupported content (${e.kind}): ${e.message}_` },
      });
    }
  }

  const provenance: UISpec["provenance"] = { tier: "L1", composedBy: "a2ui-ingest", cache: "miss" };
  if (losses.length > 0) {
    const first = losses[0]!;
    provenance.fallback = { from: first.componentId, reason: first.detail, kind: "negotiation" };
  }

  const spec: UISpec = {
    kohaku: SPEC_VERSION,
    intent: opts.intent,
    dataVersion: opts.dataVersion,
    components,
    events,
    provenance,
  };

  const issues = validateSpecStructure(spec);
  if (hasErrors(issues)) {
    const detail = issues
      .filter((i) => i.severity === "error")
      .map((i) => `${i.code} at ${i.path}: ${i.message}`)
      .join("; ");
    throw new A2uiIngestError(`fromA2ui produced a structurally invalid Spec: ${detail}`);
  }

  return { spec, losses };
}

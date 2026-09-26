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

/**
 * The reserved write-action name `attachEvent` stamps on every synthesized `action.invoke` event's
 * `payload.action` (see `attachEvent`'s doc for why). **A host MUST NEVER register this as a real
 * `DomainPort` operation** — its only correct handling is: recognize it (before dispatching to the
 * DomainPort at all), extract the forwarded `event`/`context` from the payload, and route it to
 * `toA2uiClientAction` to notify the originating agent. Registering it as a real operation would let any
 * ingested (third-party) content trigger that operation directly, since `payload.action` is exactly the
 * field spec-core's `collectWriteActions`/`resolveWriteActionName` read to decide which write capability
 * a host issues for a Spec.
 */
export const A2UI_FORWARD_ACTION = "a2ui.forward";

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
   * Escape hatch for a kohaku-catalog component's **data source** — a `"data"` prop whose value is a
   * `{path}` binding (see `convertDataBinding`'s doc). Return a kohaku query `$ref` for that path to make it
   * a genuine live `ComponentNode.data.$ref` (reference-passing, resolved by `collectCapabilityScopes`/
   * renderer-core like any other component's data source) instead of a one-time literal snapshot; a caller
   * wires this when it knows which A2UI data-model paths correspond to a live kohaku query it can
   * re-resolve. Returning `undefined` (including when this option itself is omitted) falls back to a
   * literal snapshot for that one path, recorded as a `"binding-snapshotted"` loss — same as every other
   * `{path}` binding, which `bindPath` is deliberately **never** consulted for (an ordinary display prop or
   * an event's `context` has no structural home for a live reference to begin with, only `ComponentNode.data`
   * does). Only the host's own choice of `$ref` ever reaches this, never anything the agent supplies, so a
   * read capability is issued only for a ref the host itself associated with that path.
   */
  bindPath?: (path: string) => { $ref: string } | undefined;
  /**
   * The sidecar `toA2ui`/`patchToA2ui` returned for this exact surface, if this surface is kohaku's own
   * prior output re-ingested (the round-trip case, not third-party content). When a component id has a
   * sidecar entry, it is restored **verbatim and losslessly** from `sidecar.components[id]` (and its
   * original `EventBinding`s from `sidecar.events`), bypassing every mapping rule below entirely.
   *
   * **Only consulted when `trust: "trusted"`** (see that option) — passing a `sidecar` alone does not
   * enable it, since a sidecar handed to the default `"untrusted"` mode is silently ignored rather than
   * trusted. This is deliberate: a sidecar is a structure the *caller* constructs, and `fromA2ui` cannot
   * itself distinguish "this really is kohaku's own prior `toA2ui` output" from "something shaped like a
   * sidecar that ultimately traces back to the same untrusted agent" — restoring it verbatim would bypass
   * every safety transform below (id sanitization, the props/event exclusions, `attachEvent`'s forwarding
   * envelope) for whatever it contains.
   */
  sidecar?: KohakuSidecar;
  /**
   * Whether `sidecar` (above) may be trusted. `"untrusted"` (the default, and what `createA2uiIngest`
   * always uses — see the package README's "Inbound: A2UI agent → kohaku Spec (ingest)" section): ignore
   * `sidecar` entirely, so ingest is safe against real third-party content by default. `"trusted"`: this
   * call is a genuine "kohaku's own `toA2ui` output, re-ingested" round trip (e.g. a relay/mirroring
   * scenario, or a test), so `sidecar` restoration is honored. Only set this when the surface being
   * converted is provably not third-party-influenced — never based on anything present *in* the surface
   * itself (an agent cannot elevate its own trust by claiming to be kohaku).
   */
  trust?: "untrusted" | "trusted";
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
 * Resolves one `A2uiValue` to a literal `JsonValue`. A `{path}` binding is **always** snapshotted from the
 * surface's data model here — `ctx.bindPath` is consulted only for a component's own `"data"` prop (see
 * `convertDataBinding`, the one place a binding can become a live `ComponentNode.data.$ref` instead of a
 * literal); every other position (an ordinary display prop, an event's `context`) has no structural home for
 * a live reference at all, so this always just snapshots and records the loss, never calling `bindPath`.
 * This always succeeds, it never throws. A function-call value throws `UnmappableSignal` (fromA2ui cannot
 * execute it), demoting the *whole* containing component to a placeholder — a computed value is not a
 * "leave this one field null" situation, since the value's meaning wasn't just uncertain, it was never asked
 * for from a fixed data source at all.
 */
function resolveValue(value: A2uiValue, ctx: ConvertCtx, componentId: string, hint: string): JsonValue {
  if (isBindingValue(value)) {
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

/**
 * The one place `ctx.bindPath` is actually consulted: a kohaku-catalog component's own `"data"` prop, when
 * it is a `{path}` binding, names that component's *data source* (the same concept kohaku's own outbound
 * side calls `ComponentNode.data.$ref` — `to-a2ui.ts`'s verbatim projection just never emits it, since
 * reference-passing has no wire representation at all in A2UI). Returning a real `$ref` here — instead of
 * treating it as an ordinary display prop and snapshotting it to a literal — makes it a genuine structural
 * binding: `collectCapabilityScopes`/renderer-core read `ComponentNode.data.$ref` to issue a read capability
 * and resolve it live, exactly as they would for any other kohaku component's data source.
 *
 * `bindPath` is the **host's** own hook, never the agent's: the agent can only cause a `{path}` binding to
 * exist on `"data"` at all, never choose *which* `$ref` it resolves to (that mapping lives entirely in the
 * caller-supplied `bindPath` function). A read capability is therefore only ever issued for a ref the host
 * itself chose to associate with that data-model path — an ingested surface cannot mint itself read access
 * to an arbitrary kohaku query this way.
 *
 * Returns `undefined` (not a `JsonValue`) when `value` is not a `{path}` binding, or `bindPath` is absent or
 * declines to resolve it — the caller then falls through to the ordinary `resolveValue` handling for
 * `"data"` (snapshot to a literal `props.data`, same as any other prop), never silently dropping the field.
 */
function convertDataBinding(value: A2uiValue, ctx: ConvertCtx): { $ref: string } | undefined {
  if (!isBindingValue(value)) return undefined;
  return ctx.bindPath?.(value.path);
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
 * **Security**: the payload is always `{action: A2UI_FORWARD_ACTION, event, context}`, never the raw
 * resolved `context` object directly. spec-core's `resolveWriteActionName` (consumed by
 * `collectWriteActions`, which hosts use to decide which write capability to issue for a Spec) reads
 * `payload.action` directly — since `context` is an agent-controlled, wholly open dictionary (see
 * `A2uiEventSchema`), a third-party agent could otherwise set `context: {action: "someRealOperation"}` and
 * have `collectWriteActions` mint a capability for a real domain write it never should have been able to
 * name. Nesting the resolved context under `context` keeps it out of `resolveWriteActionName`'s reach
 * entirely, and `action` is always the fixed sentinel regardless of what the agent sent. This is
 * unconditional (not gated by `trust`): `trust` only controls whether the *sidecar* escape hatch is
 * honored (see `FromA2uiOptions.trust`), and a sidecar-restored node never reaches this function at all
 * (its original `EventBinding`s, if any, are restored separately — see `convertOne`).
 *
 * The wire's `event.name` is not reused as-is for `on`'s second segment: kohaku's `EventOnSchema` requires
 * `[a-zA-Z][a-zA-Z0-9]*` there, while a third-party agent's event name is an unconstrained string. When the
 * name already satisfies that shape (the common case: "press", "click", "rowClick", …) it survives
 * unchanged as both `on`'s suffix and `payload.event`; a name that does not already satisfy it is
 * deterministically sanitized instead, which is a real, documented (README "governance proxy" section)
 * loss of exact fidelity for that one case (`payload.event` carries the same, already-sanitized name `on`
 * does, so `toA2uiClientAction` never needs to re-derive it from `on`).
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
  const context: JsonObject = {};
  for (const [key, value] of Object.entries(node.action.event.context)) {
    context[key] = resolveValue(value, ctx, result.id, `action.event.context.${key}`);
  }
  const payload: JsonObject = { action: A2UI_FORWARD_ACTION, event: eventNamePart, context };
  ctx.events.push({ on: `${result.id}.${eventNamePart}`, emit: "action.invoke", payload });
}

/**
 * Restores every `EventBinding` in `sidecar.events` whose firing component is `rawId` (matching `on`
 * against the `"<rawId>."` prefix), verbatim, onto `ctx.events`. `sidecar.events` holds the *whole*
 * original Spec's events (see `to-a2ui.ts`'s `buildSidecar`), so this is filtered per component rather
 * than restored once for the whole surface. Only called from the sidecar-restore branch of `convertOne`
 * (i.e. only when `trust: "trusted"` — see `FromA2uiOptions.trust` — since `ctx.sidecar` is `undefined`
 * otherwise), so this never runs against untrusted data.
 */
function restoreSidecarEvents(rawId: string, ctx: ConvertCtx): void {
  const prefix = `${rawId}.`;
  for (const ev of ctx.sidecar?.events ?? []) {
    if (ev.on.startsWith(prefix)) ctx.events.push(ev);
  }
}

/** Converts one raw component (identified by its *wire* id) into exactly one `ComponentNode`, or throws `UnmappableSignal`. */
function convertOne(rawId: string, node: A2uiComponent, ctx: ConvertCtx): ComponentNode {
  const restored = ctx.sidecar?.components[rawId];
  if (restored != null) {
    restoreSidecarEvents(rawId, ctx);
    return restored;
  }

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
      let data: ComponentNode["data"];
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
        // A prop literally named "data" bound to a {path} is this node's data *source* (kohaku's own
        // outbound convention for the same concept — see convertDataBinding's doc), not an ordinary display
        // prop: when ctx.bindPath resolves it to a $ref, it becomes the structural ComponentNode.data field
        // instead of an inert props.data value. Anything else about "data" (not a binding, or bindPath
        // unavailable/declining it) falls through to the exact same handling every other prop gets.
        if (key === "data") {
          const bound = convertDataBinding(value as A2uiValue, ctx);
          if (bound != null) {
            data = bound;
            continue;
          }
        }
        props[key] = resolveValue(value as A2uiValue, ctx, id, key);
      }
      const result: ComponentNode = { id, type: node.component, props };
      if (data != null) result.data = data;
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
  // The sidecar escape hatch is honored only under explicit trust: "trusted" (default "untrusted" — see
  // FromA2uiOptions.trust / sidecar's doc). A sidecar supplied without that flag is silently ignored, not
  // partially trusted, so a caller cannot be caught out by "I passed a sidecar, so it must be safe."
  const effectiveSidecar = opts.trust === "trusted" ? opts.sidecar : undefined;
  const consumedIds = computeConsumedLabelIds(surface, effectiveSidecar);
  const losses: A2uiIngestLoss[] = [];
  const events: EventBinding[] = [];
  const ctx: ConvertCtx = {
    surface,
    ...(opts.catalog != null ? { catalog: opts.catalog } : {}),
    ...(opts.bindPath != null ? { bindPath: opts.bindPath } : {}),
    ...(effectiveSidecar != null ? { sidecar: effectiveSidecar } : {}),
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

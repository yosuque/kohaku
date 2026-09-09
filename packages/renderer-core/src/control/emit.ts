import type { ComponentNode, JsonObject, JsonValue, UISpec } from "@kohaku-ui/spec-core";

/**
 * The envelope used when an event declared in the Spec is forwarded upstream
 * (server / host). The framework-free source of truth. renderer-react re-exports
 * this type as its own SurfaceEvent (context.tsx). renderer-wc puts the forwarded
 * event into the detail of a CustomEvent.
 */
export interface SurfaceEvent {
  componentId: string;
  /** "table1.rowClick" form (matches Spec's events[].on) */
  on: string;
  /** payload with placeholders ($row.x etc.) already resolved */
  payload: JsonObject;
  // "state.set" is included in the type but never appears in a forward —
  // resolveEmit handles state.set in a separate branch entirely within the
  // Renderer (never sent to the server; upholds the SPEC-EVT-002 governance).
  // Only the remaining 3 kinds are forwarded upstream.
  emit: "intent.patch" | "intent.replace" | "action.invoke" | "state.set";
}

/**
 * The governance decision for event dispatch (the sole gatekeeper of
 * SPEC-EVT-002). A pure function with no side effects that returns only the
 * decision.
 * - `drop`: an event not declared in the Spec, or a state.set whose key is not a
 *   string (discarded).
 * - `state.set`: when state should be updated within the Renderer (returns key /
 *   value; never sent to the server).
 * - `forward`: when a declared intent.* / action.invoke should be forwarded
 *   upstream (returns a SurfaceEvent).
 *
 * The actual state update / forwarding is applied by the caller (React hook / WC
 * glue). Because both renderers route through **only** this, the governance is not
 * implemented twice. `row` is the current row auto-supplied inside a row template
 * (presentList) when runtime.row is unspecified (used by resolvePayloadTemplate
 * for $row.* resolution).
 */
export type EmitResolution =
  | { kind: "state.set"; key: string; value: JsonValue }
  | { kind: "forward"; event: SurfaceEvent }
  | { kind: "drop" };

/**
 * Whether the Spec declares an event binding for `${nodeId}.${eventName}` (e.g. "table1.rowClick").
 * The single source of truth for the "is this interaction wired up at all" check that gates whether a
 * part becomes clickable/keyboard-operable (rowClick / itemClick / pointClick), avoiding duplicating
 * `spec.events.some((e) => e.on === ...)` verbatim across both renderers (and one core presenter).
 */
export function hasDeclaredEvent(spec: Pick<UISpec, "events">, nodeId: string, eventName: string): boolean {
  const on = `${nodeId}.${eventName}`;
  return spec.events.some((e) => e.on === on);
}

export function resolveEmit(
  spec: UISpec,
  node: ComponentNode,
  eventName: string,
  runtime: JsonObject,
  row?: JsonObject | null,
): EmitResolution {
  const on = `${node.id}.${eventName}`;
  const binding = spec.events.find((e) => e.on === on);
  if (binding == null) return { kind: "drop" }; // undeclared events are discarded (governance)

  // Inside a row template (presentList), when runtime.row is unspecified we
  // auto-supply the contextual row. The $row.<key> resolution grammar is unchanged
  // (this adds a supply source, not a grammar extension).
  const effectiveRuntime = row != null && runtime["row"] === undefined ? { ...runtime, row } : runtime;
  const payload = resolvePayloadTemplate(binding.payload, effectiveRuntime);

  if (binding.emit === "state.set") {
    // state.set is handled entirely within the Renderer and never forwarded
    // upstream (SPEC-EVT-002). payload.key is already guaranteed to be a static key
    // of spec.state by validateSpecStructure (STATE_SET_INVALID).
    const key = payload["key"];
    if (typeof key === "string") return { kind: "state.set", key, value: payload["value"] ?? null };
    return { kind: "drop" };
  }

  return { kind: "forward", event: { componentId: node.id, on, emit: binding.emit, payload } };
}

/**
 * Resolves a payload template:
 * "$row.<key>" → runtime.row[key] / "$value" → runtime.value (the entire form
 * value object) / "$value.<field>" → runtime.value[field] (extracts a single form
 * field) / everything else passes through unchanged.
 */
export function resolvePayloadTemplate(template: Record<string, JsonValue>, runtime: JsonObject): JsonObject {
  const row = (runtime["row"] ?? {}) as JsonObject;
  const value = runtime["value"];
  const resolved: JsonObject = {};
  for (const [key, tpl] of Object.entries(template)) {
    if (typeof tpl === "string" && tpl.startsWith("$row.")) {
      resolved[key] = row[tpl.slice("$row.".length)] ?? null;
    } else if (typeof tpl === "string" && tpl.startsWith("$value.")) {
      // Extracts a single field from the form value object (the inverse of the
      // full $value expansion; symmetric with $row.<key>). A single presentForm
      // field can be placed directly onto an action argument (e.g.
      // payload.note = "$value.note").
      const field = tpl.slice("$value.".length);
      resolved[key] =
        value != null && typeof value === "object" && !Array.isArray(value)
          ? ((value as JsonObject)[field] ?? null)
          : null;
    } else if (tpl === "$value") {
      resolved[key] = value ?? null;
    } else {
      resolved[key] = tpl;
    }
  }
  return resolved;
}

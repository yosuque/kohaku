import type { JsonValue, UISpec } from "@kohaku-ui/spec-core";

/** A single control.select option ({ value, label }). */
export interface SelectOption {
  value: string;
  label: string;
}

/**
 * A pure function that normalizes control.select's options (JsonValue input) into
 * `{ value, label }` (the same rule as normalizeOptions in
 * renderer-react/src/core/control-select.tsx; the framework-free source of truth).
 *
 * The normalizeOptions in presenters/form.ts is the typed version that accepts
 * FieldDef["options"] (an array of string | {value,label}); this one handles the
 * raw JsonValue coming from a Spec's props (also tolerating non-array input).
 * Both renderer-wc and renderer-react import this shared version directly, so
 * the option-normalization rule stays identical across renderers.
 */
export function normalizeSelectOptions(raw: JsonValue | undefined): SelectOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((o): SelectOption => {
    if (typeof o === "string") return { value: o, label: o };
    if (o != null && typeof o === "object" && !Array.isArray(o)) {
      const rec = o as Record<string, JsonValue>;
      const value = String(rec["value"] ?? "");
      return { value, label: String(rec["label"] ?? rec["value"] ?? value) };
    }
    return { value: "", label: "" };
  });
}

/**
 * Looks up the static state key that a node's own change event declaration writes to via
 * state.set (undefined if none). Shared by renderer-react's ControlSelect and renderer-wc's
 * controlSelect — the framework-free source of truth for control.select's display value.
 */
export function boundStateKey(spec: Pick<UISpec, "events">, nodeId: string): string | undefined {
  const binding = spec.events.find((e) => e.on === `${nodeId}.change`);
  if (binding == null || binding.emit !== "state.set") return undefined;
  const key = binding.payload["key"];
  return typeof key === "string" ? key : undefined;
}

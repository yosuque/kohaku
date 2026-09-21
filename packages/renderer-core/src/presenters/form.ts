import type { PresentFormField } from "@kohaku-ui/registry";
import type { ComponentNode, JsonObject, JsonValue } from "@kohaku-ui/spec-core";
import type { RendererMessages } from "../messages.js";
import type { SizingTokens } from "../theme.js";

/** The type is defined solely in registry (present-form.ts); here it is shared via a type-only import. */
export type FieldDef = PresentFormField;

/** Normalizes string options into `{ value, label }` (backward compatible). */
export function normalizeOptions(options: FieldDef["options"]): { value: string; label: string }[] {
  return (options ?? []).map((o) => (typeof o === "string" ? { value: o, label: o } : o));
}

/** Builds the initial-value map from defaultValue. */
export function buildDefaults(fields: FieldDef[]): JsonObject {
  const out: JsonObject = {};
  for (const field of fields) {
    if (field.defaultValue !== undefined) out[field.name] = field.defaultValue as JsonValue;
  }
  return out;
}

/** Overrides the initial values with the first row's values (matching column key = field.name; row value > defaultValue). */
export function mergeRow(defaults: JsonObject, fields: FieldDef[], row: JsonObject | undefined): JsonObject {
  const out: JsonObject = { ...defaults };
  if (row == null) return out;
  for (const field of fields) {
    if (Object.hasOwn(row, field.name)) {
      out[field.name] = row[field.name] as JsonValue;
    }
  }
  return out;
}

/** Normalizes a JsonValue into a string array (shaping multiselect values; a single value becomes a 1-element array). */
export function asStringArray(value: JsonValue | undefined): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (value == null || value === "") return [];
  return [String(value)];
}

/** Shapes values per type just before submit (without breaking the intermediate state during input). */
export function coerceFieldValues(fields: FieldDef[], values: JsonObject): JsonObject {
  const out: JsonObject = { ...values };
  for (const field of fields) {
    const v = out[field.name];
    if (field.type === "number" && typeof v === "string") {
      const raw = v.trim();
      const n = Number(raw);
      out[field.name] = raw === "" || Number.isNaN(n) ? null : n;
    } else if (field.type === "multiselect") {
      out[field.name] = asStringArray(v);
    } else if (field.type === "boolean") {
      out[field.name] = v === true;
    }
  }
  return out;
}

/** HTML validation attributes (placeholder / min / max / step / pattern). Spread only onto controls that support them. */
export function constraintAttrs(field: FieldDef): Record<string, string | number> {
  const a: Record<string, string | number> = {};
  if (field.placeholder != null) a["placeholder"] = field.placeholder;
  if (field.min != null) a["min"] = field.min;
  if (field.max != null) a["max"] = field.max;
  if (field.step != null) a["step"] = field.step;
  if (field.pattern != null) a["pattern"] = field.pattern;
  return a;
}

/** The constraint kinds that declarative validation can violate. */
export type FieldViolationRule = "required" | "minLength" | "maxLength" | "pattern" | "min" | "max";

/** A validation violation for a single field (consumed in the same shape by both renderers). */
export interface FieldViolation {
  /** The offending field name (field.name). The key for moving focus and for aria wiring. */
  field: string;
  /** The field's display name (field.label ?? field.name). Used when referring to it in an aggregate error. */
  label: string;
  /** The violated validation kind (the first one violated). */
  rule: FieldViolationRule;
  /** The message to display (field.message takes priority; otherwise the default message for the kind). */
  message: string;
}

/** The "empty" definition used for the required check (the meaning of "unfilled" differs per type). */
function isEmptyValue(field: FieldDef, value: JsonValue | undefined): boolean {
  if (field.type === "multiselect") return !Array.isArray(value) || value.length === 0;
  if (field.type === "boolean") return value !== true; // a required checkbox is unfilled unless it is true
  if (field.type === "number") return value == null; // after coercion, null = unfilled / not coercible to a number
  return value == null || value === "";
}

/** Matches with a full match, like HTML pattern (an invalid pattern cannot be validated, so it passes — an author's mistake should not block the user). */
function patternMatches(pattern: string, value: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`).test(value);
  } catch {
    return true;
  }
}

/** Returns the first violated kind for a single field (precedence: required → length → pattern → numeric range). null if none. */
function firstViolation(field: FieldDef, value: JsonValue | undefined): FieldViolationRule | null {
  const empty = isEmptyValue(field, value);
  if (field.required === true && empty) return "required";
  // An unfilled optional field imposes no other constraints (blank = valid).
  if (empty) return null;

  if (typeof value === "string") {
    if (field.minLength != null && value.length < field.minLength) return "minLength";
    if (field.maxLength != null && value.length > field.maxLength) return "maxLength";
    if (field.pattern != null && !patternMatches(field.pattern, value)) return "pattern";
  }
  // min/max apply only to number (date's min/max are declared as number, so they are out of scope for range matching).
  if (field.type === "number" && typeof value === "number") {
    if (field.min != null && value < field.min) return "min";
    if (field.max != null && value > field.max) return "max";
  }
  return null;
}

/** Looks up the default message for each kind from messages (the fallback when field.message is absent). */
function defaultViolationMessage(
  field: FieldDef,
  label: string,
  rule: FieldViolationRule,
  messages: RendererMessages,
): string {
  switch (rule) {
    case "required":
      return messages.formRequired(label);
    case "minLength":
      return messages.formMinLength(label, field.minLength ?? 0);
    case "maxLength":
      return messages.formMaxLength(label, field.maxLength ?? 0);
    case "pattern":
      return messages.formPattern(label);
    case "min":
      return messages.formMin(label, field.min ?? 0);
    case "max":
      return messages.formMax(label, field.max ?? 0);
  }
}

/**
 * A framework-free pure function that declaratively validates form values (both
 * renderers call it in a shared way before submit). Assumes coerced values are
 * passed (number as a number, multiselect as an array, boolean as a boolean). A
 * form that has no validation declarations (required / minLength / maxLength /
 * pattern / min / max) always returns an empty array, so the caller can submit as
 * before, making it fully backward compatible.
 */
export function validateFormValues(
  fields: FieldDef[],
  values: JsonObject,
  messages: RendererMessages,
): FieldViolation[] {
  const violations: FieldViolation[] = [];
  for (const field of fields) {
    const rule = firstViolation(field, values[field.name]);
    if (rule == null) continue;
    const label = field.label ?? field.name;
    violations.push({
      field: field.name,
      label,
      rule,
      message: field.message ?? defaultViolationMessage(field, label, rule, messages),
    });
  }
  return violations;
}

/** The submit decision (coerce → validate → payload-or-violations) shared by both renderers. */
export interface FormSubmitPlan {
  coerced: JsonObject;
  violations: FieldViolation[];
  /** Non-null only when there is no violation — the exact payload to invoke `submit` with. */
  payload: { value: JsonObject } | null;
}

/**
 * Plans a form submit: shapes the values, validates them, and fixes the submit payload contract
 * (`{ value: coerced }`) in one place. On violations the caller shows them and moves focus to the
 * first violating field instead of submitting.
 */
export function planFormSubmit(
  fields: FieldDef[],
  values: JsonObject,
  messages: RendererMessages,
): FormSubmitPlan {
  const coerced = coerceFieldValues(fields, values);
  const violations = validateFormValues(fields, coerced, messages);
  return { coerced, violations, payload: violations.length > 0 ? null : { value: coerced } };
}

/**
 * The selector pair for moving focus to a violating field: by id first, then by name
 * (radio inputs have no id — the group shares `name=${nodeId}-${field}` instead).
 */
export function focusFieldSelectors(nodeId: string, fieldName: string): [string, string] {
  const fieldId = `${nodeId}-${fieldName}`;
  return [`[id="${fieldId}"]`, `[name="${fieldId}"]`];
}

/**
 * The "fill initial values once per ref + data version" key (an edit form must not overwrite the
 * user's typing on unrelated re-renders, but must refill when the data version advances).
 */
export function formFillKey(node: Pick<ComponentNode, "data">, dataVersion: string | undefined): string {
  return `${node.data?.$ref ?? ""}@${dataVersion ?? ""}`;
}

/** Per-field row metadata (ids / label / grouping) shared by both renderers. */
export interface FieldRowMeta {
  fieldId: string;
  /** Present only when the field declares helpText (the id the help text carries). */
  helpId: string | undefined;
  /** The id the inline error carries when a violation is shown. */
  errorId: string;
  labelText: string;
  required: boolean;
  /** radio is multiple inputs: labelled via role="group" + aria-label instead of a single <label for>. */
  isGroup: boolean;
}

/** Derives the row metadata for one field (the id scheme `${nodeId}-${name}[-help|-error]` in one place). */
export function describeFieldRow(nodeId: string, field: FieldDef): FieldRowMeta {
  const fieldId = `${nodeId}-${field.name}`;
  return {
    fieldId,
    helpId: field.helpText != null ? `${fieldId}-help` : undefined,
    errorId: `${fieldId}-error`,
    labelText: field.label ?? field.name,
    required: field.required === true,
    isGroup: field.type === "radio",
  };
}

/** aria-describedby with the order fixed as help → error. undefined when neither is present. */
export function describedByOf(helpId: string | undefined, errorId: string | undefined): string | undefined {
  return [helpId, errorId].filter(Boolean).join(" ") || undefined;
}

/**
 * The framework-free decisions of the per-type control switch. Each renderer keeps only its own
 * element/JSX emission and event wiring; which tag/type/attributes a field type maps to lives here.
 */
export interface ControlDescriptor {
  kind: "select" | "multiselect" | "radio" | "checkbox" | "textarea" | "input";
  /** The input's type attribute (kind "input" only). */
  inputType?: "text" | "date" | "email" | "url";
  /** number-only: keep the raw string while typing (type=text) and hint a numeric keyboard. */
  inputMode?: "decimal";
  /** number-only: the pattern fallback applied when the field declares none. */
  pattern?: string;
  /** HTML constraint attributes to spread onto the control (empty for kinds that support none). */
  constraints: Record<string, string | number>;
  /** textarea-only. */
  rows?: number;
  /** multiselect-only (px). */
  minHeight?: number;
}

/**
 * Maps a field type to its control decisions. Notable fixed decisions (kept in one place instead of
 * duplicated in both renderers): number renders as type=text + inputMode=decimal (immediate Number() conversion would
 * round intermediate inputs like "1." and jump the caret) and takes only placeholder from the
 * constraint attributes (min/max are enforced by validateFormValues instead of the browser).
 */
export function describeControl(field: FieldDef): ControlDescriptor {
  switch (field.type) {
    case "select":
      return { kind: "select", constraints: {} };
    case "multiselect":
      return { kind: "multiselect", constraints: {}, minHeight: 88 };
    case "radio":
      return { kind: "radio", constraints: {} };
    case "boolean":
      return { kind: "checkbox", constraints: {} };
    case "textarea":
      return { kind: "textarea", constraints: constraintAttrs(field), rows: 4 };
    case "number":
      return {
        kind: "input",
        inputType: "text",
        inputMode: "decimal",
        pattern: field.pattern ?? "[0-9.\\-]*",
        constraints: field.placeholder != null ? { placeholder: field.placeholder } : {},
      };
    case "date":
    case "email":
    case "url":
      return { kind: "input", inputType: field.type, constraints: constraintAttrs(field) };
    default:
      return { kind: "input", inputType: "text", constraints: constraintAttrs(field) };
  }
}

// --- Style constants/functions shared verbatim by both renderers (React's style prop and WC's setStyle consume the same shape). ---

/** The form root's layout. */
export function formRootStyle(sizing: SizingTokens) {
  return { display: "flex", flexDirection: "column", gap: sizing.space3, maxWidth: 480 } as const;
}

/** One field row's layout. */
export function fieldRowStyle(sizing: SizingTokens) {
  return { display: "flex", flexDirection: "column", gap: sizing.space1, fontSize: sizing.fontSm } as const;
}

/** The base look of input/select/textarea controls. */
export function formControlBaseStyle(border: string, sizing: SizingTokens) {
  return {
    border: `1px solid ${border}`,
    borderRadius: sizing.radiusMd,
    padding: `${sizing.space2} ${sizing.space3}`,
    fontSize: sizing.fontMd,
  } as const;
}

/** The control-bar select (e.g. a spreadsheet/list filter) and a form's <select> deliberately share one chrome. */
export function controlSelectStyle(border: string, sizing: SizingTokens) {
  return formControlBaseStyle(border, sizing);
}

/** The submit button (busy switches the affordance without disabling resubmission after a failure). */
export function formSubmitButtonStyle(
  accent: string,
  onPrimary: string,
  options: { busy: boolean },
  sizing: SizingTokens,
) {
  const { busy } = options;
  return {
    alignSelf: "flex-start",
    background: accent,
    color: onPrimary,
    border: "none",
    borderRadius: sizing.radiusMd,
    padding: `${sizing.space2} ${sizing.space4}`,
    fontSize: sizing.fontMd,
    fontWeight: 600,
    cursor: busy ? ("not-allowed" as const) : ("pointer" as const),
    opacity: busy ? 0.6 : 1,
  } as const;
}

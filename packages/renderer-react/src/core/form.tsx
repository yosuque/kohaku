import {
  asStringArray,
  buildDefaults,
  describeControl,
  describedByOf,
  describeFieldRow,
  FIELD_ROW_STYLE,
  type FieldDef,
  type FieldViolation,
  FORM_ROOT_STYLE,
  focusFieldSelectors,
  formControlBaseStyle,
  formFillKey,
  formSubmitButtonStyle,
  mergeRow,
  normalizeOptions,
  planFormSubmit,
} from "@kohaku-ui/renderer-core";
import type { JsonObject, JsonValue } from "@kohaku-ui/spec-core";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { type ImplProps, useMessages, useToken } from "../context.js";
import type { RendererMessages } from "../messages.js";
import { useBoundData } from "../use-bound-data.js";
import { useInvokeAction } from "../use-invoke-action.js";
import { DataStateNotice } from "./data-states.js";

// The form's pure logic (options normalization / defaults / row merge / coerce / validation attributes) uses renderer-core
// as the single source of truth (imported rather than kept as a self-contained copy). FieldDef = registry's PresentFormField.

export function PresentForm({ node }: ImplProps): ReactNode {
  const messages = useMessages();
  const accent = String(useToken("color.primary"));
  const border = String(useToken("color.border"));
  const onPrimary = String(useToken("color.on-primary"));
  const negativeText = String(useToken("color.negative.text"));
  const positiveText = String(useToken("color.positive.text"));
  const requiredColor = String(useToken("color.negative"));
  const muted = String(useToken("color.muted"));
  const fieldRowColors: FieldRowColors = { border, muted, requiredColor, errorColor: negativeText };
  const fields = (node.props["fields"] as unknown as FieldDef[]) ?? [];

  // Write-execution hook (wires submit directly to action.invoke; if binding is unset, auto-falls back to onEvent forwarding).
  const { state: actionState, invoke } = useInvokeAction(node);
  const submitting = actionState.phase === "pending";

  // If node.data exists, fill initial values from the first row (an "edit this record" form).
  const hasData = node.data?.$ref != null;
  const bound = useBoundData(node);
  const dataLoading = hasData && bound.status === "loading";
  const dataProblem = hasData && (bound.status === "stale" || bound.status === "error");

  const defaults = useMemo(() => buildDefaults(fields), [fields]);
  const [values, setValues] = useState<JsonObject>(defaults);
  const filledKey = useRef<string | null>(null);

  // Declarative validation violations (recomputed on submit; a form with no validation declaration is always empty, keeping the legacy behavior).
  const [violations, setViolations] = useState<FieldViolation[]>([]);
  const violationByField = useMemo(() => new Map(violations.map((v) => [v.field, v])), [violations]);
  const formRef = useRef<HTMLFormElement>(null);
  // Move focus to the first violating field (radio has no id, so pick it up by name).
  const focusField = (name: string): void => {
    const form = formRef.current;
    if (form == null) return;
    const [byId, byName] = focusFieldSelectors(node.id, name);
    (form.querySelector<HTMLElement>(byId) ?? form.querySelector<HTMLElement>(byName))?.focus();
  };

  useEffect(() => {
    if (!hasData || bound.status !== "ready") return;
    // Fill once per ref + data version (do not overwrite while the user is editing; refill when the version advances).
    const key = formFillKey(node, bound.dataVersion);
    if (filledKey.current === key) return;
    filledKey.current = key;
    setValues(mergeRow(defaults, fields, bound.data.rows[0]));
  }, [hasData, bound, defaults, fields, node]);

  const set = (name: string, value: JsonValue): void => setValues((prev) => ({ ...prev, [name]: value }));

  // Inputs are disabled during data resolution and submission. After a submit failure, do not disable so it can be resubmitted.
  const busy = dataLoading || submitting;

  return (
    <form
      ref={formRef}
      data-kohaku={node.id}
      aria-busy={busy || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        const plan = planFormSubmit(fields, values, messages);
        setViolations(plan.violations);
        if (plan.payload == null) {
          // If there are violations, do not submit and move focus to the first violating field.
          focusField(plan.violations[0]!.field);
          return;
        }
        void invoke("submit", plan.payload);
      }}
      style={FORM_ROOT_STYLE}
    >
      {violations.length > 0 && (
        <div role="alert" style={{ color: negativeText, fontSize: 13 }}>
          <span>{messages.formErrorSummary(violations.length)}</span>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {violations.map((v) => (
              <li key={v.field}>{`${v.label}: ${v.message}`}</li>
            ))}
          </ul>
        </div>
      )}
      {dataProblem && <DataStateNotice state={bound} />}
      {fields.map((field) => (
        <FieldRow
          key={field.name}
          field={field}
          nodeId={node.id}
          value={values[field.name]}
          set={set}
          disabled={busy}
          colors={fieldRowColors}
          messages={messages}
          violation={violationByField.get(field.name)}
        />
      ))}
      <button
        type="submit"
        disabled={busy}
        aria-busy={submitting || undefined}
        style={formSubmitButtonStyle(accent, onPrimary, { busy })}
      >
        {(node.props["submitLabel"] as string) ?? messages.formSubmit}
      </button>
      {/* Submit result: success surfaces as non-interrupting (status), failure as interrupting (alert). */}
      {actionState.phase === "succeeded" && (
        <div role="status" style={{ color: positiveText, fontSize: 13 }}>
          {(node.props["successMessage"] as string) ?? messages.formSubmitted}
        </div>
      )}
      {actionState.phase === "failed" && (
        <div role="alert" style={{ color: negativeText, fontSize: 13 }}>
          {actionState.message}
        </div>
      )}
    </form>
  );
}

/** Color tokens FieldRow needs (border / muted / requiredColor / errorColor), bundled as one parameter object (same shape as renderer-wc's `colors`). */
interface FieldRowColors {
  border: string;
  muted: string;
  requiredColor: string;
  errorColor: string;
}

/** One field's row (label/group + control + help text). */
function FieldRow({
  field,
  nodeId,
  value,
  set,
  disabled,
  colors,
  messages,
  violation,
}: {
  field: FieldDef;
  nodeId: string;
  value: JsonValue | undefined;
  set: (name: string, value: JsonValue) => void;
  disabled: boolean;
  colors: FieldRowColors;
  messages: RendererMessages;
  violation: FieldViolation | undefined;
}): ReactNode {
  const { border, muted, requiredColor, errorColor } = colors;
  // ids / label / grouping come from renderer-core's describeFieldRow (the shared id scheme with renderer-wc).
  const meta = describeFieldRow(nodeId, field);
  const { fieldId, helpId, labelText, required } = meta;
  const errorId = violation != null ? meta.errorId : undefined;
  const requiredMark = required ? (
    // The required marker is visual only. The required semantics are carried by the input's aria-required, so treat it as decorative.
    <span aria-hidden="true" style={{ color: requiredColor }}>
      {" "}
      *
    </span>
  ) : null;
  const help =
    field.helpText != null ? (
      <span id={helpId} style={{ color: muted, fontSize: 12 }}>
        {field.helpText}
      </span>
    ) : null;

  // radio is multiple controls (multiple inputs) so it cannot be tied with htmlFor → use role="group" + aria-label.
  // Otherwise it is a single control, so use <label htmlFor> (explicit association). Wrapping the control in a label
  // creates a double association with htmlFor and causes assistive tech/tests to double-detect, so do not wrap; tie with htmlFor alone.
  const isGroup = meta.isGroup;
  return (
    <div {...(isGroup ? { role: "group", "aria-label": labelText } : {})} style={FIELD_ROW_STYLE}>
      {isGroup ? (
        <span style={{ fontWeight: 600 }}>
          {labelText}
          {requiredMark}
        </span>
      ) : (
        <label htmlFor={fieldId} style={{ fontWeight: 600 }}>
          {labelText}
          {requiredMark}
        </label>
      )}
      {renderControl(field, fieldId, helpId, errorId, value, set, disabled, border, messages)}
      {help}
      {violation != null && (
        <span id={errorId} style={{ color: errorColor, fontSize: 12 }}>
          {violation.message}
        </span>
      )}
    </div>
  );
}

function renderControl(
  field: FieldDef,
  fieldId: string,
  helpId: string | undefined,
  errorId: string | undefined,
  value: JsonValue | undefined,
  set: (name: string, value: JsonValue) => void,
  disabled: boolean,
  border: string,
  messages: RendererMessages,
): ReactNode {
  // The per-type decisions (tag / input type / constraint attributes / inputMode / rows / minHeight)
  // come from renderer-core's describeControl; only the JSX emission and event wiring live here.
  const desc = describeControl(field);
  const baseStyle = formControlBaseStyle(border);
  // Bundle both help and error into aria-describedby (order fixed as help → error).
  const describedBy = describedByOf(helpId, errorId);
  const common = {
    id: fieldId,
    disabled,
    "aria-required": field.required || undefined,
    "aria-invalid": errorId != null || undefined,
    "aria-describedby": describedBy,
  };

  switch (desc.kind) {
    case "select":
      return (
        <select
          {...common}
          required={field.required}
          value={String(value ?? "")}
          onChange={(e) => set(field.name, e.target.value)}
          style={baseStyle}
        >
          <option value="">{messages.formSelectPlaceholder}</option>
          {normalizeOptions(field.options).map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      );
    case "multiselect":
      return (
        <select
          {...common}
          multiple
          value={asStringArray(value)}
          onChange={(e) =>
            set(
              field.name,
              [...e.target.selectedOptions].map((o) => o.value),
            )
          }
          style={{ ...baseStyle, minHeight: desc.minHeight }}
        >
          {normalizeOptions(field.options).map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      );
    case "radio":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {normalizeOptions(field.options).map((opt) => (
            <label key={opt.value} style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400 }}>
              <input
                type="radio"
                name={fieldId}
                value={opt.value}
                disabled={disabled}
                aria-invalid={errorId != null || undefined}
                aria-describedby={describedBy}
                checked={String(value ?? "") === opt.value}
                onChange={() => set(field.name, opt.value)}
              />
              {opt.label}
            </label>
          ))}
        </div>
      );
    case "checkbox":
      return (
        <input
          {...common}
          type="checkbox"
          checked={value === true}
          onChange={(e) => set(field.name, e.target.checked)}
        />
      );
    case "textarea":
      return (
        <textarea
          {...common}
          {...desc.constraints}
          required={field.required}
          value={String(value ?? "")}
          onChange={(e) => set(field.name, e.target.value)}
          rows={desc.rows}
          style={baseStyle}
        />
      );
    case "input":
      // Covers text / number / date / email / url — number keeps the raw string while typing and converts on
      // submit (immediate Number() conversion would round intermediate inputs like "1." or "-" and jump the
      // caret); the type/inputMode/pattern decisions are in describeControl.
      return (
        <input
          {...common}
          {...desc.constraints}
          type={desc.inputType}
          {...(desc.inputMode != null ? { inputMode: desc.inputMode } : {})}
          {...(desc.pattern != null ? { pattern: desc.pattern } : {})}
          required={field.required}
          value={String(value ?? "")}
          onChange={(e) => set(field.name, e.target.value)}
          style={baseStyle}
        />
      );
  }
}

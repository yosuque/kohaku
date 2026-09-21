import {
  asStringArray,
  type BoundData,
  buildDefaults,
  describeControl,
  describedByOf,
  describeFieldRow,
  type FieldDef,
  type FieldViolation,
  fieldRowStyle,
  focusFieldSelectors,
  formControlBaseStyle,
  formFillKey,
  formRootStyle,
  formSubmitButtonStyle,
  mergeRow,
  normalizeOptions,
  planFormSubmit,
  type SizingTokens,
} from "@kohaku-ui/renderer-core";
import type { JsonObject, JsonValue } from "@kohaku-ui/spec-core";
import { el, noop, setAttrs, setStyle, text } from "../dom.js";
import type { ActionPhase, PartBuilder, RenderRuntime, Teardown } from "../types.js";
import { dataStateNotice, tokenStr } from "./kit.js";

/**
 * presentForm — an input form (same behavior as renderer-react's PresentForm). Wires submit directly to action.invoke
 * (auto-falls back to onEvent forwarding if binding is unset). If node.data exists, initial values are filled from the first row.
 *
 * To preserve focus/caret, WC does not swap the whole element; it locally updates only value filling, busy, and submit result
 * (the final submit payload matches React's controlled re-render).
 */
export const presentForm: PartBuilder = (rt, parent, node, row) => {
  const accent = tokenStr(rt, "color.primary");
  const border = tokenStr(rt, "color.border");
  const onPrimary = tokenStr(rt, "color.on-primary");
  const positiveText = tokenStr(rt, "color.positive.text");
  const negativeText = tokenStr(rt, "color.negative.text");
  const requiredColor = tokenStr(rt, "color.negative");
  const muted = tokenStr(rt, "color.muted");
  const fields = (node.props["fields"] as unknown as FieldDef[]) ?? [];

  const defaults = buildDefaults(fields);
  const values: JsonObject = { ...defaults };
  const applyValue = new Map<string, (v: JsonValue | undefined) => void>();
  // Display of declarative-validation violations (locally updates aria-invalid + inline error per field).
  const applyError = new Map<string, (v: FieldViolation | undefined) => void>();
  const disablers: ((disabled: boolean) => void)[] = [];

  const form = el("form", { "data-kohaku": node.id }, formRootStyle(rt.sizing)) as HTMLFormElement;

  // Aggregated error slot for validation violations (at the form's start; inserts a role="alert" div).
  const summarySlot = document.createComment(`kohaku:form-summary:${node.id}`);
  form.appendChild(summarySlot);
  let summaryNode: ChildNode = summarySlot;
  const setSummary = (next: Node | null): void => {
    const replacement = next ?? document.createComment(`kohaku:form-summary:${node.id}`);
    summaryNode.replaceWith(replacement);
    summaryNode = replacement as ChildNode;
  };

  // Notification slot for the data-resolution state (stale/error) (right after the aggregated error).
  const noticeSlot = document.createComment(`kohaku:form-notice:${node.id}`);
  form.appendChild(noticeSlot);
  let noticeNode: ChildNode = noticeSlot;
  const setNotice = (next: Node | null): void => {
    const replacement = next ?? document.createComment(`kohaku:form-notice:${node.id}`);
    noticeNode.replaceWith(replacement);
    noticeNode = replacement as ChildNode;
  };

  const fieldColors = { border, muted, requiredColor, errorColor: negativeText };
  for (const field of fields) {
    form.appendChild(buildFieldRow(rt, node, field, values, fieldColors, applyValue, applyError, disablers));
  }

  const submit = el("button", { type: "submit" }) as HTMLButtonElement;
  submit.appendChild(text(String((node.props["submitLabel"] as string) ?? rt.messages.formSubmit)));
  form.appendChild(submit);

  // Slot for the submit-result message.
  const resultSlot = document.createComment(`kohaku:form-result:${node.id}`);
  form.appendChild(resultSlot);
  let resultNode: ChildNode = resultSlot;
  const setResult = (next: Node | null): void => {
    const replacement = next ?? document.createComment(`kohaku:form-result:${node.id}`);
    resultNode.replaceWith(replacement);
    resultNode = replacement as ChildNode;
  };

  // Reflect busy (data resolving or submitting). After a submit failure, resubmission is allowed, so it is not disabled.
  let dataLoading = false;
  let submitting = false;
  const applyBusy = (): void => {
    const busy = dataLoading || submitting;
    for (const d of disablers) d(busy);
    submit.disabled = busy;
    if (busy) form.setAttribute("aria-busy", "true");
    else form.removeAttribute("aria-busy");
    if (submitting) submit.setAttribute("aria-busy", "true");
    else submit.removeAttribute("aria-busy");
    setStyle(submit, formSubmitButtonStyle(accent, onPrimary, { busy }, rt.sizing));
  };
  applyBusy();

  const onPhase = (phase: ActionPhase): void => {
    submitting = phase.phase === "pending";
    applyBusy();
    if (phase.phase === "succeeded") {
      const msg = String((node.props["successMessage"] as string) ?? rt.messages.formSubmitted);
      const div = el("div", { role: "status" }, { color: positiveText, fontSize: rt.sizing.fontSm });
      div.appendChild(text(msg));
      setResult(div);
    } else if (phase.phase === "failed") {
      const div = el("div", { role: "alert" }, { color: negativeText, fontSize: rt.sizing.fontSm });
      div.appendChild(text(phase.message));
      setResult(div);
    }
  };

  // Move focus to the first violating field (radios have no id, so they are picked up by name).
  const focusField = (name: string): void => {
    const [byId, byName] = focusFieldSelectors(node.id, name);
    (form.querySelector<HTMLElement>(byId) ?? form.querySelector<HTMLElement>(byName))?.focus();
  };

  // Reflect the validation result in the DOM (each field's aria-invalid/inline + the aggregated error at the top).
  const applyViolations = (found: FieldViolation[]): void => {
    const byField = new Map(found.map((v) => [v.field, v]));
    for (const field of fields) applyError.get(field.name)?.(byField.get(field.name));
    setSummary(
      found.length > 0
        ? buildSummary(rt.messages.formErrorSummary(found.length), found, negativeText, rt.sizing)
        : null,
    );
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (dataLoading || submitting) return;
    const plan = planFormSubmit(fields, values, rt.messages);
    applyViolations(plan.violations);
    if (plan.payload == null) {
      // If there are violations, do not submit and move focus to the first violating field.
      focusField(plan.violations[0]!.field);
      return;
    }
    void rt.invoke(node, "submit", plan.payload, row, onPhase);
  });

  // If node.data exists, fill initial values from the first row (once per ref + data version; does not overwrite while editing).
  let detach: Teardown = noop;
  const hasData = node.data?.$ref != null;
  if (hasData) {
    let filledKey: string | null = null;
    detach = rt.controller.attach(node, rt.spec, (state: BoundData) => {
      dataLoading = state.status === "loading";
      applyBusy();
      const problem = state.status === "stale" || state.status === "error";
      setNotice(problem ? dataStateNotice(rt, state) : null);
      if (state.status === "ready") {
        const key = formFillKey(node, state.dataVersion);
        if (filledKey !== key) {
          filledKey = key;
          const merged = mergeRow(defaults, fields, state.data.rows[0]);
          for (const field of fields) {
            values[field.name] = merged[field.name] as JsonValue;
            applyValue.get(field.name)?.(merged[field.name]);
          }
        }
      }
    });
  }

  parent.appendChild(form);
  return () => {
    detach();
    form.remove();
  };
};

/** A single field's row (label/group + control + help text + inline error). */
function buildFieldRow(
  rt: RenderRuntime,
  node: { id: string },
  field: FieldDef,
  values: JsonObject,
  colors: { border: string; muted: string; requiredColor: string; errorColor: string },
  applyValue: Map<string, (v: JsonValue | undefined) => void>,
  applyError: Map<string, (v: FieldViolation | undefined) => void>,
  disablers: ((disabled: boolean) => void)[],
): HTMLElement {
  const { border, muted, requiredColor, errorColor } = colors;
  // ids / label / grouping come from renderer-core's describeFieldRow (the shared id scheme with renderer-react).
  const { fieldId, helpId, errorId, labelText, required, isGroup } = describeFieldRow(node.id, field);

  const rowEl = el("div", {}, fieldRowStyle(rt.sizing));
  if (isGroup) setAttrs(rowEl, { role: "group", "aria-label": labelText });

  const labelEl = el(isGroup ? "span" : "label", {}, { fontWeight: 600 });
  if (!isGroup) labelEl.setAttribute("for", fieldId);
  labelEl.appendChild(text(labelText));
  if (required) {
    const star = el("span", { "aria-hidden": "true" }, { color: requiredColor });
    star.appendChild(text(" *"));
    labelEl.appendChild(star);
  }
  rowEl.appendChild(labelEl);

  const controlEl = buildControl(rt, field, fieldId, helpId, values, border, applyValue, disablers);
  rowEl.appendChild(controlEl);

  if (field.helpText != null) {
    const help = el("span", { id: helpId }, { color: muted, fontSize: rt.sizing.fontXs });
    help.appendChild(text(field.helpText));
    rowEl.appendChild(help);
  }

  // Inline error slot (inserts a span only on violation; equivalent to React's conditional render, emitting nothing to the DOM when there is no violation).
  const errorSlot = document.createComment(`kohaku:form-error:${fieldId}`);
  rowEl.appendChild(errorSlot);
  let errorNode: ChildNode = errorSlot;
  // The controls that carry aria-invalid / aria-describedby (radio is multiple inputs, otherwise a single element).
  const controls: Element[] = controlEl.matches("input,select,textarea")
    ? [controlEl]
    : [...controlEl.querySelectorAll("input,select,textarea")];
  applyError.set(field.name, (violation) => {
    if (violation != null) {
      const span = el("span", { id: errorId }, { color: errorColor, fontSize: rt.sizing.fontXs });
      span.appendChild(text(violation.message));
      errorNode.replaceWith(span);
      errorNode = span;
      for (const c of controls) {
        c.setAttribute("aria-invalid", "true");
        c.setAttribute("aria-describedby", describedByOf(helpId, errorId)!);
      }
    } else {
      const comment = document.createComment(`kohaku:form-error:${fieldId}`);
      errorNode.replaceWith(comment);
      errorNode = comment;
      for (const c of controls) {
        c.removeAttribute("aria-invalid");
        if (helpId != null) c.setAttribute("aria-describedby", helpId);
        else c.removeAttribute("aria-describedby");
      }
    }
  });

  return rowEl;
}

/** Aggregated error for validation violations (role="alert"; a count heading + a mention of each field). Semantically equivalent to React's aggregated div. */
function buildSummary(
  heading: string,
  violations: FieldViolation[],
  errorColor: string,
  sizing: SizingTokens,
): HTMLElement {
  const div = el("div", { role: "alert" }, { color: errorColor, fontSize: sizing.fontSm });
  const head = el("span");
  head.appendChild(text(heading));
  div.appendChild(head);
  const ul = el("ul", {}, { margin: "4px 0 0", paddingLeft: 18 });
  for (const v of violations) {
    const li = el("li");
    li.appendChild(text(`${v.label}: ${v.message}`));
    ul.appendChild(li);
  }
  div.appendChild(ul);
  return div;
}

function buildControl(
  rt: RenderRuntime,
  field: FieldDef,
  fieldId: string,
  helpId: string | undefined,
  values: JsonObject,
  border: string,
  applyValue: Map<string, (v: JsonValue | undefined) => void>,
  disablers: ((disabled: boolean) => void)[],
): HTMLElement {
  const name = field.name;
  // The per-type decisions (tag / input type / constraint attributes / inputmode / rows / minHeight)
  // come from renderer-core's describeControl; only the element assembly and event wiring live here.
  const desc = describeControl(field);
  const baseStyle = formControlBaseStyle(border, rt.sizing);
  const common = (elm: HTMLElement): void => {
    elm.id = fieldId;
    if (field.required === true) elm.setAttribute("aria-required", "true");
    if (helpId != null) elm.setAttribute("aria-describedby", helpId);
  };
  const registerDisable = (elm: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): void => {
    disablers.push((disabled) => {
      elm.disabled = disabled;
    });
  };

  switch (desc.kind) {
    case "select": {
      const select = el("select", {}, baseStyle) as HTMLSelectElement;
      common(select);
      if (field.required === true) select.required = true;
      const placeholder = el("option", { value: "" }) as HTMLOptionElement;
      placeholder.appendChild(text(rt.messages.formSelectPlaceholder));
      select.appendChild(placeholder);
      for (const opt of normalizeOptions(field.options)) {
        const o = el("option", { value: opt.value }) as HTMLOptionElement;
        o.appendChild(text(opt.label));
        select.appendChild(o);
      }
      select.value = String(values[name] ?? "");
      select.addEventListener("change", () => (values[name] = select.value));
      applyValue.set(name, (v) => (select.value = String(v ?? "")));
      registerDisable(select);
      return select;
    }
    case "multiselect": {
      const select = el(
        "select",
        { multiple: true },
        { ...baseStyle, minHeight: desc.minHeight },
      ) as HTMLSelectElement;
      common(select);
      for (const opt of normalizeOptions(field.options)) {
        const o = el("option", { value: opt.value }) as HTMLOptionElement;
        o.appendChild(text(opt.label));
        select.appendChild(o);
      }
      const applyMulti = (v: JsonValue | undefined): void => {
        const set = new Set(asStringArray(v));
        for (const o of [...select.options]) o.selected = set.has(o.value);
      };
      applyMulti(values[name]);
      select.addEventListener("change", () => {
        values[name] = [...select.selectedOptions].map((o) => o.value);
      });
      applyValue.set(name, applyMulti);
      registerDisable(select);
      return select;
    }
    case "radio": {
      const group = el("div", {}, { display: "flex", flexDirection: "column", gap: rt.sizing.space1 });
      const inputs: HTMLInputElement[] = [];
      for (const opt of normalizeOptions(field.options)) {
        const lbl = el(
          "label",
          {},
          { display: "flex", alignItems: "center", gap: rt.sizing.space2, fontWeight: 400 },
        );
        const input = el("input", { type: "radio", name: fieldId, value: opt.value }) as HTMLInputElement;
        if (helpId != null) input.setAttribute("aria-describedby", helpId);
        input.checked = String(values[name] ?? "") === opt.value;
        input.addEventListener("change", () => (values[name] = opt.value));
        inputs.push(input);
        lbl.append(input, text(opt.label));
        group.appendChild(lbl);
        registerDisable(input);
      }
      applyValue.set(name, (v) => {
        for (const input of inputs) input.checked = String(v ?? "") === input.value;
      });
      return group;
    }
    case "checkbox": {
      const input = el("input", { type: "checkbox" }) as HTMLInputElement;
      common(input);
      input.checked = values[name] === true;
      input.addEventListener("change", () => (values[name] = input.checked));
      applyValue.set(name, (v) => (input.checked = v === true));
      registerDisable(input);
      return input;
    }
    case "textarea": {
      const ta = el("textarea", {}, baseStyle) as HTMLTextAreaElement;
      common(ta);
      setAttrs(ta, desc.constraints);
      if (field.required === true) ta.required = true;
      if (desc.rows != null) ta.rows = desc.rows;
      ta.value = String(values[name] ?? "");
      ta.addEventListener("input", () => (values[name] = ta.value));
      applyValue.set(name, (v) => (ta.value = String(v ?? "")));
      registerDisable(ta);
      return ta;
    }
    case "input": {
      // Covers text / number / date / email / url — number keeps the raw string while typing and coerces
      // on submit (does not break intermediate input); the type/inputmode/pattern decisions are in describeControl.
      const input = el(
        "input",
        {
          type: desc.inputType,
          ...(desc.inputMode != null ? { inputmode: desc.inputMode } : {}),
          ...(desc.pattern != null ? { pattern: desc.pattern } : {}),
        },
        baseStyle,
      ) as HTMLInputElement;
      common(input);
      setAttrs(input, desc.constraints);
      if (field.required === true) input.required = true;
      input.value = String(values[name] ?? "");
      input.addEventListener("input", () => (values[name] = input.value));
      applyValue.set(name, (v) => (input.value = String(v ?? "")));
      registerDisable(input);
      return input;
    }
  }
}

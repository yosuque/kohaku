import { boundStateKey, controlSelectStyle, normalizeSelectOptions } from "@kohaku-ui/renderer-core";
import { el, text } from "../dom.js";
import type { PartBuilder } from "../types.js";
import { tokenStr } from "./kit.js";

/**
 * control.select — a lightweight select (same as renderer-react's ControlSelect). On change, fires the selected value ($value).
 * If `<id>.change` → emit "state.set" is declared, rt.emit updates $state (the existing state.set path), and
 * parts that carry data.bind re-resolve their effective ref, making cross-filtering work (without firing a compose).
 * The displayed value follows the current value of the $state key it writes to.
 */
export const controlSelect: PartBuilder = (rt, parent, node, row) => {
  const border = tokenStr(rt, "color.border");
  const options = normalizeSelectOptions(node.props["options"]);
  const placeholder = node.props["placeholder"];
  const label = node.props["label"];

  const select = el(
    "select",
    { "data-kohaku": node.id },
    { ...controlSelectStyle(border, rt.sizing), alignSelf: "flex-start" },
  ) as HTMLSelectElement;
  if (label != null) select.setAttribute("aria-label", String(label));

  if (placeholder != null) {
    const opt = el("option", { value: "" }) as HTMLOptionElement;
    opt.appendChild(text(String(placeholder)));
    select.appendChild(opt);
  }
  for (const opt of options) {
    const o = el("option", { value: opt.value }) as HTMLOptionElement;
    o.appendChild(text(opt.label));
    select.appendChild(o);
  }

  // Use as the displayed value the current value of the state key that this element's change writes via state.set (falling back to props.value).
  const boundKey = boundStateKey(rt.spec, node.id);
  const readValue = (): string => {
    const stateValue = boundKey != null ? rt.store.get(boundKey) : undefined;
    return String(stateValue ?? node.props["value"] ?? "");
  };
  select.value = readValue();

  select.addEventListener("change", () => {
    rt.emit(node, "change", { value: select.value }, row);
  });

  // Update the displayed value following $state changes (also reflecting state.set from other controls via A1 cross-filtering).
  const unsub = rt.store.subscribe(() => {
    const next = readValue();
    if (select.value !== next) select.value = next;
  });

  parent.appendChild(select);
  return () => {
    unsub();
    select.remove();
  };
};

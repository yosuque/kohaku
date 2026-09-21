import { boundStateKey, controlSelectStyle, normalizeSelectOptions } from "@kohaku-ui/renderer-core";
import type { ReactNode } from "react";
import { type ImplProps, useEmitEvent, useSizing, useSpec, useToken } from "../context.js";
import { useSpecState } from "../spec-state.js";

/**
 * Lightweight select control (control.select, kohaku >= 0.2 [Draft]). Enables client-local cross-filtering
 * without a recompose round-trip.
 * Fires the selected value ($value) on the change event. If event `<id>.change` → emit "state.set" is
 * declared, useEmitEvent updates $state (reusing the existing state.set path without modification), and
 * components with data.bind re-resolve their effective ref, establishing cross-filtering (without firing compose).
 * It holds no data (options are static props).
 *
 * The display value is controlled by referencing the current value of the $state key its own change writes to (tracks state changes).
 * If there is no declaration / the emit is not state.set, it falls back to the static props.value.
 * a11y: it is a single control but placed standalone, so give it a name by copying props.label to aria-label
 * (the same level as form.tsx's select being named via <label htmlFor>).
 */
export function ControlSelect({ node }: ImplProps): ReactNode {
  const spec = useSpec();
  const stateApi = useSpecState();
  const emit = useEmitEvent(node);
  const sizing = useSizing();
  const border = String(useToken("color.border"));

  const options = normalizeSelectOptions(node.props["options"]);
  const placeholder = node.props["placeholder"];
  const label = node.props["label"];

  // Use as the display value the current value of the state key (if any) that its own change writes to via state.set.
  const boundKey = boundStateKey(spec, node.id);
  const stateValue = boundKey != null ? stateApi.get(boundKey) : undefined;
  const value = String(stateValue ?? node.props["value"] ?? "");

  return (
    <select
      data-kohaku={node.id}
      {...(label != null ? { "aria-label": String(label) } : {})}
      value={value}
      onChange={(e) => emit("change", { value: e.target.value })}
      style={{ ...controlSelectStyle(border, sizing), alignSelf: "flex-start" }}
    >
      {placeholder != null && <option value="">{String(placeholder)}</option>}
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

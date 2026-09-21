import { actionButtonStyle } from "@kohaku-ui/renderer-core";
import { el, setStyle, text } from "../dom.js";
import type { ActionPhase, PartBuilder } from "../types.js";
import { tokenStr } from "./kit.js";

/**
 * action.button — an action button (same as renderer-react's ActionButton). Fires press.
 * If press has emit==="action.invoke" and binding is configured, it runs the write directly and, while running,
 * is disabled + aria-busy. Otherwise it forwards via emit to onEvent (rt.invoke decides).
 */
export const actionButton: PartBuilder = (rt, parent, node, row) => {
  const primary = tokenStr(rt, "color.primary");
  const border = tokenStr(rt, "color.border");
  const danger = tokenStr(rt, "color.danger");
  const textColor = tokenStr(rt, "color.text");
  const onPrimary = tokenStr(rt, "color.on-primary");

  const label = String(node.props["label"] ?? "");
  const variant = (node.props["variant"] as string) ?? "primary";
  const baseDisabled = node.props["disabled"] === true;
  const tokens = { primary, border, danger, text: textColor, onPrimary };

  const button = el("button", { "data-kohaku": node.id, type: "button" });
  button.appendChild(text(label));

  const apply = (phase: ActionPhase): void => {
    const pending = phase.phase === "pending";
    const disabled = baseDisabled || pending;
    (button as HTMLButtonElement).disabled = disabled;
    if (pending) button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
    setStyle(button, actionButtonStyle(variant, tokens, { disabled }, rt.sizing));
  };
  apply({ phase: "idle" });

  button.addEventListener("click", () => {
    void rt.invoke(node, "press", {}, row, apply);
  });

  parent.appendChild(button);
  return () => button.remove();
};

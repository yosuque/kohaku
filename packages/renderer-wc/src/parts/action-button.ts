import { actionButtonStyle, actionPhaseNotice } from "@kohaku-ui/renderer-core";
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
  const negativeText = tokenStr(rt, "color.negative.text");

  const label = String(node.props["label"] ?? "");
  const variant = (node.props["variant"] as string) ?? "primary";
  const baseDisabled = node.props["disabled"] === true;
  const tokens = { primary, border, danger, text: textColor, onPrimary };

  const button = el("button", { "data-kohaku": node.id, type: "button" });
  button.appendChild(text(label));

  // Slot for the notice shown when the action did not commit (invalid / awaitingApproval), right after the button.
  const noticeSlot = document.createComment(`kohaku:action-notice:${node.id}`);
  let noticeNode: ChildNode = noticeSlot;
  const setNotice = (next: Node | null): void => {
    const replacement = next ?? document.createComment(`kohaku:action-notice:${node.id}`);
    noticeNode.replaceWith(replacement);
    noticeNode = replacement as ChildNode;
  };

  const apply = (phase: ActionPhase): void => {
    const pending = phase.phase === "pending";
    const disabled = baseDisabled || pending;
    (button as HTMLButtonElement).disabled = disabled;
    if (pending) button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
    setStyle(button, actionButtonStyle(variant, tokens, { disabled }, rt.sizing));

    const notice = actionPhaseNotice(phase, rt.messages);
    if (notice == null) {
      setNotice(null);
      return;
    }
    const color = notice.role === "alert" ? negativeText : textColor;
    const div = el("div", { role: notice.role }, { color, fontSize: rt.sizing.fontSm });
    div.appendChild(text(notice.text));
    setNotice(div);
  };
  // Attach before the first apply: the notice slot is swapped in place, which needs a parent.
  parent.appendChild(button);
  parent.appendChild(noticeSlot);
  apply({ phase: "idle" });

  button.addEventListener("click", () => {
    void rt.invoke(node, "press", {}, row, apply);
  });

  return () => {
    button.remove();
    noticeNode.remove();
  };
};

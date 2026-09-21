import { actionButtonStyle } from "@kohaku-ui/renderer-core";
import type { CSSProperties, ReactNode } from "react";
import { type ImplProps, useSizing, useToken } from "../context.js";
import { useInvokeAction } from "../use-invoke-action.js";

/**
 * Action button (action.button). Fires the press event. variant expresses importance, and
 * colors go through theme tokens (the same style as the existing components). disabled uses the real attribute to disable operation.
 * If press is not declared in the Spec's events, it is discarded (governance).
 *
 * If press's binding has emit==="action.invoke" and a BindingClient is configured, it executes the write directly and,
 * while executing, sets disabled + aria-busy. Otherwise it forwards to onEvent (useInvokeAction decides).
 */
export function ActionButton({ node }: ImplProps): ReactNode {
  const { state, invoke } = useInvokeAction(node);
  const sizing = useSizing();
  const primary = String(useToken("color.primary"));
  const border = String(useToken("color.border"));
  const danger = String(useToken("color.danger"));
  const text = String(useToken("color.text"));
  const onPrimary = String(useToken("color.on-primary"));

  const label = String(node.props["label"] ?? "");
  const variant = (node.props["variant"] as string) ?? "primary";
  const pending = state.phase === "pending";
  const disabled = node.props["disabled"] === true || pending;

  const style = actionButtonStyle(
    variant,
    { primary, border, danger, text, onPrimary },
    { disabled },
    sizing,
  );

  return (
    <button
      data-kohaku={node.id}
      type="button"
      disabled={disabled}
      aria-busy={pending || undefined}
      onClick={() => void invoke("press", {})}
      style={style as CSSProperties}
    >
      {label}
    </button>
  );
}

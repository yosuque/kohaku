import type { ReactNode } from "react";
import { type ImplProps, useToken } from "../context.js";

/**
 * Skeleton for the in-progress streaming form (ui.loading). role="status" + aria-busy="true"
 * tells assistive tech "loading." The spinner is decorative, so aria-hidden. It is self-contained via SVG's animateTransform,
 * avoiding dependence on global CSS (@keyframes). The label has a default value in props.label.
 */
export function UiLoading({ node }: ImplProps): ReactNode {
  const label = String(node.props["label"] ?? "Loading…");
  const muted = String(useToken("color.muted"));
  const border = String(useToken("color.border"));
  return (
    <div
      data-kohaku={node.id}
      role="status"
      aria-busy="true"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        color: muted,
        fontSize: 13,
        padding: "10px 12px",
      }}
    >
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" style={{ flexShrink: 0 }}>
        <circle cx="8" cy="8" r="6" fill="none" stroke={border} strokeWidth="2" />
        <path d="M8 2 a6 6 0 0 1 6 6" fill="none" stroke={muted} strokeWidth="2" strokeLinecap="round">
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 8 8"
            to="360 8 8"
            dur="0.7s"
            repeatCount="indefinite"
          />
        </path>
      </svg>
      {label}
    </div>
  );
}

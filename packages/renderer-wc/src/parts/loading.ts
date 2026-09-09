import { el, svgEl, text } from "../dom.js";
import type { PartBuilder } from "../types.js";
import { tokenStr } from "./kit.js";

/**
 * ui.loading — a skeleton for the intermediate streaming state (same markup as renderer-react's UiLoading).
 * role="status" + aria-busy="true". The spinner is a self-contained aria-hidden SVG (animateTransform).
 */
export const uiLoading: PartBuilder = (rt, parent, node) => {
  const label = String(node.props["label"] ?? "Loading…");
  const muted = tokenStr(rt, "color.muted");
  const border = tokenStr(rt, "color.border");

  const container = el(
    "div",
    { "data-kohaku": node.id, role: "status", "aria-busy": "true" },
    { display: "flex", alignItems: "center", gap: 10, color: muted, fontSize: 13, padding: "10px 12px" },
  );

  const svg = svgEl(
    "svg",
    { "aria-hidden": "true", width: "16", height: "16", viewBox: "0 0 16 16" },
    {
      flexShrink: 0,
    },
  );
  svg.appendChild(
    svgEl("circle", { cx: "8", cy: "8", r: "6", fill: "none", stroke: border, "stroke-width": "2" }),
  );
  const path = svgEl("path", {
    d: "M8 2 a6 6 0 0 1 6 6",
    fill: "none",
    stroke: muted,
    "stroke-width": "2",
    "stroke-linecap": "round",
  });
  path.appendChild(
    svgEl("animateTransform", {
      attributeName: "transform",
      type: "rotate",
      from: "0 8 8",
      to: "360 8 8",
      dur: "0.7s",
      repeatCount: "indefinite",
    }),
  );
  svg.appendChild(path);

  container.appendChild(svg);
  container.appendChild(text(label));
  parent.appendChild(container);
  return () => container.remove();
};

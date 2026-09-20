import {
  type BoundData,
  metricCardStyle,
  metricDeltaStyle,
  metricLabelStyle,
  metricValueStyle,
  resolveMetricView,
} from "@kohaku-ui/renderer-core";
import type { ComponentNode } from "@kohaku-ui/spec-core";
import { el, text } from "../dom.js";
import type { PartBuilder, RenderRuntime } from "../types.js";
import { dataStateNotice, mountBoundPart, tokenStr } from "./kit.js";

/**
 * presentMetric — presentation of a single KPI value (same markup / a11y as renderer-react's PresentMetric).
 * Shows the value and its change large, from the first row of the data reference. The change is made explicit beyond color, via a symbol (▲/▼) + a signed value.
 * The whole is composed into a single aria-label, and the decorative text is aria-hidden. The container carries
 * `role="group"` because a plain div's implicit role does not permit `aria-label` (ARIA in HTML AAM); `group` does,
 * and it does not add the container to the page landmark structure.
 * The view model (value/delta formatting, delta color, aria label) comes from renderer-core's resolveMetricView; only the markup is emitted here.
 */
export const presentMetric: PartBuilder = (rt, parent, node) =>
  mountBoundPart(rt, parent, node, (state) => ({ el: renderMetric(rt, node, state) }));

function renderMetric(rt: RenderRuntime, node: ComponentNode, state: BoundData): Node {
  if (state.status !== "ready") {
    // Non-ready states show a DataStateNotice (which has no data-kohaku). On ready it swaps to the metric body.
    return dataStateNotice(rt, state)!;
  }

  const muted = tokenStr(rt, "color.muted");
  const surface = tokenStr(rt, "color.surface");
  const border = tokenStr(rt, "color.border");
  const view = resolveMetricView(
    node,
    state.data.rows[0],
    {
      muted,
      positive: tokenStr(rt, "color.positive"),
      negative: tokenStr(rt, "color.negative"),
    },
    rt.messages,
    rt.locale,
  );

  const container = el(
    "div",
    { "data-kohaku": node.id, role: "group", "aria-label": view.ariaLabel },
    metricCardStyle({ surface, border }, rt.sizing),
  );

  const labelSpan = el("span", { "aria-hidden": "true" }, metricLabelStyle(muted, rt.sizing));
  labelSpan.appendChild(text(view.label));
  const valueSpan = el("span", { "aria-hidden": "true" }, metricValueStyle(rt.sizing));
  valueSpan.appendChild(text(view.valueText));
  container.append(labelSpan, valueSpan);

  if (view.delta != null) {
    const deltaSpan = el("span", { "aria-hidden": "true" }, metricDeltaStyle(view.deltaColor, rt.sizing));
    deltaSpan.appendChild(text(`${view.delta.arrow} ${view.delta.signed}`));
    container.appendChild(deltaSpan);
  }

  return container;
}

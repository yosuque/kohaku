import {
  metricCardStyle,
  metricDeltaStyle,
  metricLabelStyle,
  metricValueStyle,
  resolveMetricView,
} from "@kohaku-ui/renderer-core";
import type { ReactNode } from "react";
import { type ImplProps, useLocale, useMessages, useSizing, useToken } from "../context.js";
import { useBoundData } from "../use-bound-data.js";
import { DataStateNotice } from "./data-states.js";

/**
 * Presents a single KPI value (presentMetric). Shows the value and its change large, from the first row of a data reference.
 * The change makes its direction explicit with a symbol (▲/▼) + a signed value, not relying on color alone (a11y). The whole
 * is read out as a single aria-label (conveying the value followed by the period-over-period change).
 * The container carries `role="group"` because a plain div's implicit role does not permit `aria-label` (ARIA in HTML AAM);
 * `group` does, and it does not add the container to the page landmark structure.
 * The view model (value/delta formatting, delta color, aria label) comes from renderer-core's resolveMetricView; only the markup is emitted here.
 */
export function PresentMetric({ node }: ImplProps): ReactNode {
  const state = useBoundData(node);
  const messages = useMessages();
  const locale = useLocale();
  const sizing = useSizing();
  const muted = String(useToken("color.muted"));
  const positiveColor = String(useToken("color.positive"));
  const negativeColor = String(useToken("color.negative"));
  const surface = String(useToken("color.surface"));
  const border = String(useToken("color.border"));

  if (state.status !== "ready") return <DataStateNotice state={state} />;

  const view = resolveMetricView(
    node,
    state.data.rows[0],
    { muted, positive: positiveColor, negative: negativeColor },
    messages,
    locale,
  );

  return (
    // role="group" is deliberate (see the module docstring above): a plain div's implicit role does not
    // permit aria-label, but "group" does. <fieldset> is form-grouping semantics (and a default border)
    // that don't fit a KPI display, and renderer-wc/src/parts/metric.ts mirrors this exact div+role for
    // React/WC DOM parity, so this stays a div+role rather than being swapped to a semantic element.
    // biome-ignore lint/a11y/useSemanticElements: deliberate div+role="group" (see comment above); not a form <fieldset>.
    <div
      data-kohaku={node.id}
      role="group"
      aria-label={view.ariaLabel}
      style={metricCardStyle({ surface, border }, sizing)}
    >
      <span aria-hidden="true" style={metricLabelStyle(muted, sizing)}>
        {view.label}
      </span>
      <span aria-hidden="true" style={metricValueStyle(sizing)}>
        {view.valueText}
      </span>
      {view.delta != null && (
        <span aria-hidden="true" style={metricDeltaStyle(view.deltaColor, sizing)}>
          {view.delta.arrow} {view.delta.signed}
        </span>
      )}
    </div>
  );
}

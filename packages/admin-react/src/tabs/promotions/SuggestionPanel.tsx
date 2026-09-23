import type { SchemaSuggestionView } from "@kohaku-ui/client";
import type { ReactNode } from "react";
import { useAdmin } from "../../context.js";
import { V } from "../../theme.js";
import type { SuggestionFieldDiff } from "./suggestion.js";

/**
 * The advisory block under a candidate's draft form: who proposed the prefill (model + confidence), the
 * proposed events, a field-level diff of the reviewer's current form against the proposal, and the mandatory
 * acknowledgement the approve button is gated on (the ticket's "required confirmation" against rubber-stamping
 * a machine proposal). Pure presentation; state (the form and the checkbox) stays in PromotionCard.
 */
export function SuggestionPanel(props: {
  suggestion: SchemaSuggestionView;
  diff: SuggestionFieldDiff[];
  acknowledged: boolean;
  onAcknowledge: (value: boolean) => void;
}): ReactNode {
  const { suggestion, diff, acknowledged, onAcknowledge } = props;
  const { messages: t } = useAdmin();
  const confidencePct = Math.round(suggestion.confidence * 100);
  return (
    <section
      aria-label={t.promotions.suggestionTitle}
      style={{
        border: `1px solid ${V.border}`,
        borderRadius: 8,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong>{t.promotions.suggestionTitle}</strong>
        <span style={{ color: V.muted }}>
          {t.promotions.suggestionBadge(suggestion.model, confidencePct)}
        </span>
      </div>
      {suggestion.events.length > 0 && (
        <div>{t.promotions.suggestionEvents(suggestion.events.map((e) => e.name).join(", "))}</div>
      )}
      <ul style={{ margin: 0, paddingLeft: 16, display: "flex", flexDirection: "column", gap: 2 }}>
        {diff.map((d) => (
          <li
            key={d.field}
            data-testid={`suggestion-diff-${d.field}`}
            style={{ color: d.changed ? V.warningText : V.muted }}
          >
            <code>{d.field}</code>:{" "}
            {d.changed
              ? t.promotions.suggestionChangedFrom(d.suggested === "" ? "(empty)" : d.suggested)
              : t.promotions.suggestionUnchanged}
          </li>
        ))}
      </ul>
      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input type="checkbox" checked={acknowledged} onChange={(e) => onAcknowledge(e.target.checked)} />
        {t.promotions.suggestionAcknowledge}
      </label>
      {!acknowledged && (
        <div role="status" style={{ color: V.warningText }}>
          {t.promotions.suggestionAcknowledgeRequired}
        </div>
      )}
    </section>
  );
}

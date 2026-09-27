import type { ExplainCompose } from "@kohaku-ui/client";
import type { CSSProperties, ReactNode } from "react";
import { V } from "../../theme.js";
import { Empty, sectionTitle } from "../../ui.js";
import type { DevToolsMessages } from "../messages.js";

const line: CSSProperties = { fontSize: 12.5, padding: "3px 0" };

/** The decision flow: L1/L2 attempts (with their failure issues), capability-negotiation downgrades,
 * single-flight coalescing, and summed token usage. */
export function DecisionPanel(props: { composes: ExplainCompose[]; messages: DevToolsMessages }): ReactNode {
  const t = props.messages;
  const withDecision = props.composes.filter((c) => c.decision != null);
  if (withDecision.length === 0) return <Empty text={t.decision.empty} />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {withDecision.map((c, i) => {
        const decision = c.decision!;
        return (
          <div key={c.eventId}>
            {withDecision.length > 1 && (
              <div style={{ ...sectionTitle, fontSize: 12 }}>
                {t.composeIndex(i + 1, withDecision.length)}
              </div>
            )}
            {decision.attempts.map((a, ai) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: attempts have no stable identity of their own.
              <div key={ai} style={line}>
                <strong>{a.kind}</strong>: {a.ok ? t.decision.attemptOk : t.decision.attemptFailed}
                {a.issues != null && a.issues.length > 0 && (
                  <ul style={{ margin: "2px 0 0 20px", color: V.muted }}>
                    {a.issues.map((issue, ii) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: issue strings have no stable identity of their own.
                      <li key={ii}>{issue}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            {(decision.downgrades ?? []).map((d) => (
              <div key={d.id} style={{ ...line, color: V.warningText }}>
                {t.decision.downgradeLabel(d.id, d.from, d.to)} — {d.reason}
              </div>
            ))}
            {decision.coalesced === true && <div style={line}>{t.decision.coalescedLabel}</div>}
            {decision.usage != null && (
              <div style={line}>
                {t.decision.usageLabel(decision.usage.inputTokens, decision.usage.outputTokens)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

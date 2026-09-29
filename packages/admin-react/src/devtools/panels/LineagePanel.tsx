import type { LineageEventRecord } from "@kohaku-ui/spec-core";
import type { CSSProperties, ReactNode } from "react";
import { V } from "../../theme.js";
import { lineageTierCell } from "../../tiers.js";
import { Empty } from "../../ui.js";
import type { DevToolsMessages } from "../messages.js";

const row: CSSProperties = { borderBottom: `1px solid ${V.border}`, padding: "5px 0" };
const summary: CSSProperties = {
  display: "flex",
  gap: 8,
  fontSize: 12,
  fontFamily: "ui-monospace, monospace",
  cursor: "pointer",
};

function TierLabel(props: { event: LineageEventRecord }): ReactNode {
  const cell = lineageTierCell(props.event);
  if (cell == null) return null;
  return (
    <span
      style={{ color: cell.color || V.subtle, fontWeight: 700 }}
      data-kohaku-tier-kind={cell.gate ? "gate" : "composition"}
    >
      {cell.text}
    </span>
  );
}

/** Every lineage event found under the request's correlationId, in append order, each expandable to its
 * raw payload (the decision flow's underlying evidence). */
export function LineagePanel(props: { events: LineageEventRecord[]; messages: DevToolsMessages }): ReactNode {
  const t = props.messages;
  if (props.events.length === 0) return <Empty text={t.lineage.empty} />;
  return (
    <div>
      {props.events.map((e) => (
        <details key={e.id} style={row}>
          <summary style={summary}>
            <span style={{ color: V.muted, whiteSpace: "nowrap" }}>{e.ts.slice(11, 19)}</span>
            <span style={{ fontWeight: 700 }}>{e.type}</span>
            <TierLabel event={e} />
          </summary>
          <pre
            style={{
              fontSize: 11,
              background: V.surface,
              padding: 8,
              borderRadius: 6,
              overflowX: "auto",
              marginTop: 4,
            }}
          >
            {JSON.stringify(e.payload, null, 2)}
          </pre>
        </details>
      ))}
    </div>
  );
}

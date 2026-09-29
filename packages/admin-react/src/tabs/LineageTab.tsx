import type { LineageEventRecord } from "@kohaku-ui/spec-core";
import type { ReactNode } from "react";
import { useAdmin } from "../context.js";
import { useLineage } from "../hooks.js";
import { V } from "../theme.js";
import { lineageTierCell } from "../tiers.js";
import { card, smallButton } from "../ui.js";

function LineageTierTd(props: { event: LineageEventRecord }): ReactNode {
  const cell = lineageTierCell(props.event);
  return (
    <td
      style={{ padding: "5px 8px", color: cell?.color || V.subtle, fontWeight: 700 }}
      data-kohaku-tier-kind={cell == null ? undefined : cell.gate ? "gate" : "composition"}
    >
      {cell?.text ?? ""}
    </td>
  );
}

/** The audit timeline (GET /lineage, newest first): type / tier / cache / canonical / short intent hash / surface. */
export function LineageTab(): ReactNode {
  const { messages: t } = useAdmin();
  const { events, reload } = useLineage();
  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 13, color: V.muted }}>{t.lineage.description}</div>
        <button type="button" onClick={reload} style={smallButton}>
          {t.refresh}
        </button>
      </div>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 12,
          fontFamily: "ui-monospace, Menlo, monospace",
        }}
      >
        <tbody>
          {events.map((e) => (
            <tr key={e.id} style={{ borderBottom: `1px solid ${V.border}` }}>
              <td style={{ padding: "5px 8px", whiteSpace: "nowrap", color: V.muted }} title={e.ts}>
                {`${e.ts.slice(11, 19)}Z`}
              </td>
              <td style={{ padding: "5px 8px", fontWeight: 600 }}>{e.type}</td>
              <LineageTierTd event={e} />
              <td style={{ padding: "5px 8px" }}>{String(e.payload["cache"] ?? "")}</td>
              <td style={{ padding: "5px 8px" }}>
                {String(
                  e.payload["canonical"] ?? e.payload["componentType"] ?? e.payload["artifactId"] ?? "",
                )}
              </td>
              <td style={{ padding: "5px 8px", color: V.muted }}>
                {String(e.payload["intentHash"] ?? "")
                  .replace("sha256:", "#")
                  .slice(0, 10)}
              </td>
              <td style={{ padding: "5px 8px", color: V.muted }}>{String(e.payload["surface"] ?? "")}</td>
            </tr>
          ))}
          {events.length === 0 && (
            <tr>
              <td style={{ padding: 16, color: V.muted }}>{t.lineage.empty}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

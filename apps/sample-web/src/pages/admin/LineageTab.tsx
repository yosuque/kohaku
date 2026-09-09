import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useT } from "../../i18n/ui.js";
import { apiFetch } from "../../kohaku/client.js";
import { card, smallButton, TIER_COLOR } from "./ui.js";

interface LineageEvent {
  id: string;
  ts: string;
  type: string;
  actor: { kind: string; id?: string; model?: string };
  payload: Record<string, unknown>;
}

export function LineageTab(): ReactNode {
  const [events, setEvents] = useState<LineageEvent[]>([]);
  const t = useT();
  const reload = useCallback(() => {
    void apiFetch("/api/kohaku/lineage?limit=120")
      .then((r) => r.json())
      .then((j: { events: LineageEvent[] }) => setEvents([...j.events].reverse()));
  }, []);
  useEffect(reload, [reload]);

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 13, color: "var(--app-muted, #6b7280)" }}>{t.admin.lineage.description}</div>
        <button type="button" onClick={reload} style={smallButton}>
          {t.admin.refresh}
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
            <tr key={e.id} style={{ borderBottom: "1px solid var(--app-border, #f1f5f9)" }}>
              <td style={{ padding: "5px 8px", whiteSpace: "nowrap", color: "var(--app-muted, #9ca3af)" }}>
                {e.ts.slice(11, 19)}
              </td>
              <td style={{ padding: "5px 8px", fontWeight: 600 }}>{e.type}</td>
              <td
                style={{
                  padding: "5px 8px",
                  color: TIER_COLOR[String(e.payload["tier"])] ?? "var(--app-subtle, #475569)",
                  fontWeight: 700,
                }}
              >
                {String(e.payload["tier"] ?? "")}
              </td>
              <td style={{ padding: "5px 8px" }}>{String(e.payload["cache"] ?? "")}</td>
              <td style={{ padding: "5px 8px" }}>
                {String(
                  e.payload["canonical"] ?? e.payload["componentType"] ?? e.payload["artifactId"] ?? "",
                )}
              </td>
              <td style={{ padding: "5px 8px", color: "var(--app-muted, #6b7280)" }}>
                {String(e.payload["intentHash"] ?? "")
                  .replace("sha256:", "#")
                  .slice(0, 10)}
              </td>
              <td style={{ padding: "5px 8px", color: "var(--app-muted, #9ca3af)" }}>
                {String(e.payload["surface"] ?? "")}
              </td>
            </tr>
          ))}
          {events.length === 0 && (
            <tr>
              <td style={{ padding: 16, color: "var(--app-muted, #9ca3af)" }}>{t.admin.lineage.empty}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

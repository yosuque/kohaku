import type { UISpec } from "@kohaku-ui/spec-core";
import type { ReactNode } from "react";
import { useT } from "../i18n/ui.js";

/**
 * Displays the raw Spec JSON. A visualization of "what the LLM assembles is the plumbing, not the water":
 * data contains only $ref (query references), with no aggregated values or row data at all.
 */
export function SpecJsonDrawer({ spec }: { spec: UISpec }): ReactNode {
  const t = useT();
  return (
    <details style={{ fontSize: 12 }}>
      <summary style={{ cursor: "pointer", color: "var(--app-muted, #6b7280)", userSelect: "none" }}>
        {t.chrome.specJsonSummary}
      </summary>
      <pre
        style={{
          background: "#0f172a",
          color: "#e2e8f0",
          borderRadius: 8,
          padding: 14,
          overflowX: "auto",
          fontSize: 11.5,
          lineHeight: 1.6,
          maxHeight: 420,
          overflowY: "auto",
        }}
      >
        {JSON.stringify(spec, null, 2)}
      </pre>
    </details>
  );
}

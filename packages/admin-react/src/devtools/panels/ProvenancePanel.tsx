import type { ExplainCompose } from "@kohaku-ui/client";
import type { CSSProperties, ReactNode } from "react";
import { V } from "../../theme.js";
import { Empty, sectionTitle } from "../../ui.js";
import type { DevToolsMessages } from "../messages.js";

const row: CSSProperties = { display: "flex", gap: 8, fontSize: 12.5, padding: "3px 0" };
const rowLabel: CSSProperties = { color: V.muted, minWidth: 150 };

/** Tier / cache / model / generator version / design kit / fallback for each compose in the report. */
export function ProvenancePanel(props: {
  composes: ExplainCompose[];
  messages: DevToolsMessages;
}): ReactNode {
  const t = props.messages;
  if (props.composes.length === 0) return <Empty text={t.provenance.empty} />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {props.composes.map((c, i) => (
        <div key={c.eventId}>
          {props.composes.length > 1 && (
            <div style={{ ...sectionTitle, fontSize: 12 }}>
              {t.composeIndex(i + 1, props.composes.length)}
            </div>
          )}
          <div style={row}>
            <span style={rowLabel}>{t.provenance.tierCacheLabel}</span>
            <span style={{ fontWeight: 700 }}>
              {c.tier} / {c.cache}
            </span>
          </div>
          <div style={row}>
            <span style={rowLabel}>Intent</span>
            <span>
              {c.canonical} ({c.intentHash})
            </span>
          </div>
          {c.model != null && (
            <div style={row}>
              <span style={rowLabel}>{t.provenance.modelLabel}</span>
              <span>{c.model}</span>
            </div>
          )}
          {c.generatorVersion != null && (
            <div style={row}>
              <span style={rowLabel}>{t.provenance.generatorVersionLabel}</span>
              <span>{c.generatorVersion}</span>
            </div>
          )}
          {c.kit != null && (
            <div style={row}>
              <span style={rowLabel}>{t.provenance.designKitLabel}</span>
              <span>
                {c.kit.id}@{c.kit.version}
              </span>
            </div>
          )}
          {c.fallback != null && (
            <div style={row}>
              <span style={rowLabel}>{t.provenance.fallbackLabel(c.fallback.kind ?? "generation")}</span>
              <span>
                {c.fallback.from}: {c.fallback.reason}
              </span>
            </div>
          )}
          <div style={row}>
            <span style={rowLabel}>specHash</span>
            <span style={{ color: V.muted, fontFamily: "ui-monospace, monospace" }}>{c.specHash}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

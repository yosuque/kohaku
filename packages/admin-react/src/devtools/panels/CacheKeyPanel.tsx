import type { ExplainCompose } from "@kohaku-ui/client";
import type { CSSProperties, ReactNode } from "react";
import { V } from "../../theme.js";
import { Empty, sectionTitle } from "../../ui.js";
import type { DevToolsMessages } from "../messages.js";

const row: CSSProperties = {
  display: "flex",
  gap: 8,
  fontSize: 12,
  padding: "2px 0",
  fontFamily: "ui-monospace, monospace",
};
const rowLabel: CSSProperties = { color: V.muted, minWidth: 150 };

/** The opaque cache key plus its breakdown into named components (see @kohaku-ui/spec-core's CacheKeyParts). */
export function CacheKeyPanel(props: { composes: ExplainCompose[]; messages: DevToolsMessages }): ReactNode {
  const t = props.messages;
  const withKeys = props.composes.filter((c) => c.cacheKey != null);
  if (withKeys.length === 0) return <Empty text={t.cacheKey.empty} />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {withKeys.map((c, i) => (
        <div key={c.eventId}>
          {withKeys.length > 1 && (
            <div style={{ ...sectionTitle, fontSize: 12 }}>{t.composeIndex(i + 1, withKeys.length)}</div>
          )}
          <div style={{ ...row, wordBreak: "break-all" }}>
            <span style={rowLabel}>{t.cacheKey.keyLabel}</span>
            <span>{c.cacheKey}</span>
          </div>
          {c.cacheKeyParts != null && (
            <div style={{ marginTop: 4, paddingLeft: 8, borderLeft: `2px solid ${V.border}` }}>
              <div style={row}>
                <span style={rowLabel}>{t.cacheKey.specVersionLabel}</span>
                <span>{c.cacheKeyParts.specVersion ?? "—"}</span>
              </div>
              <div style={row}>
                <span style={rowLabel}>{t.cacheKey.intentHashLabel}</span>
                <span>{c.cacheKeyParts.intentHash}</span>
              </div>
              <div style={row}>
                <span style={rowLabel}>{t.cacheKey.dataVersionLabel}</span>
                <span>{c.cacheKeyParts.dataVersion}</span>
              </div>
              <div style={row}>
                <span style={rowLabel}>{t.cacheKey.catalogFingerprintLabel}</span>
                <span>{c.cacheKeyParts.catalogFingerprint ?? "—"}</span>
              </div>
              <div style={row}>
                <span style={rowLabel}>{t.cacheKey.generatorVersionLabel}</span>
                <span>{c.cacheKeyParts.generatorVersion ?? "—"}</span>
              </div>
              <div style={row}>
                <span style={rowLabel}>{t.cacheKey.policyFingerprintLabel}</span>
                <span>{c.cacheKeyParts.policyFingerprint ?? "—"}</span>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
